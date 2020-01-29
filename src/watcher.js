const EventEmitter = require("events")

const { Contract, utils } = require("ethers")

const MonoplasmaState = require("./state")
const { replayOn, mergeEventLists } = require("./utils/events")
const { throwIfSetButNotContract, throwIfSetButBadAddress } = require("./utils/checkArguments")
const bisectFindFirstIndex = require("./utils/bisectFindFirstIndex")

const TokenJson = require("../build/ERC20Mintable.json")
const MonoplasmaJson = require("../build/Monoplasma.json")

const log = require("debug")("Streamr::CPS::watcher")

// TODO: this typedef is foobar. How to get the real thing with JSDoc?
/** @typedef {number} BigNumber */

/**
 * Rewrote ethers.js parseLog mainly because of naming incompatibilities (also use of "this"... hrrr...)
 * This one pulls an ugly one and mutates incoming logs (adds "event" and "args")
 * It's here only until ethers.js v5 is out: "if you use v5, you can use contract.queryFilter, which will include the parsed events" https://github.com/ethers-io/ethers.js/issues/37
 *
 * @see https://github.com/ethers-io/ethers.js/blob/master/utils/interface.js#L357
 * @param {utils.Interface} interface from ethers Contract.interface
 * @param {Array<utils.LogDescription>} logs from Provider.getLogs
 */
function parseLogs(interface, logs) {
    for (const log of logs) {
        for (const type in interface.events) {
            const event = interface.events[type]
            if (event.topic === log.topics[0]) {
                log.event = event.name
                log.args = event.decode(log.data, log.topics)
            }
        }
    }
}

/** TODO: this might belong to state? getLatestBlockSummary, getLatestWithdrawableBlockSummary
 * @typedef {Object} BlockSummary
 * @property {Number} blockNumber
 * @property {Number} timestamp when the Monoplasma block was stored, NOT Ethereum block timestamp
 * @property {Number} memberCount
 * @property {Number} totalEarnings
 */

/**
 * Don't send the full member list back, only member count
 * @returns {BlockSummary}
 */
function summarizeBlock(block) {
    if (!block || !block.members) { block = { members: [] } }
    return {
        blockNumber: block.blockNumber || 0,
        timestamp: block.timestamp || 0,
        memberCount: block.members.length,
        totalEarnings: block.totalEarnings || 0,
    }
}

/**
 * MonoplasmaWatcher hooks to the Ethereum root chain contract and Streamr join/part stream
 * It syncs the state from Ethereum and Streamr into the store
 */
module.exports = class MonoplasmaWatcher extends EventEmitter {

    constructor(eth, joinPartChannel, store) {
        super()
        this.eth = eth
        this.channel = joinPartChannel
        this.store = store

        // TODO: move messageCache to streamrChannel? I.e. require playback of old messages.
        this.messageCache = []
        this.cachePrunedUpTo = 0    // TODO: this is here mostly for debug / error catching purposes

        this.filters = {}
        this.eventLogIndex = +new Date()
        this.blockTimestampCache = {}
    }

    /**
     * Sync the state into store, start listening to events and messages
     * @param {MonoplasmaConfig} config
     * @returns {Promise} resolves when MonoplasmaState is synced and listeners added
     */
    async start(config) {
        await throwIfSetButNotContract(this.eth, config.contractAddress, "contractAddress from initial config")
        this.log = log.extend(config.contractAddress)

        // TODO: this isn't even used; maybe should throw if it's different from what contract gives?
        throwIfSetButBadAddress(config.adminAddress, "adminAddress from initial config")

        const network = await this.eth.getNetwork()
        this.log(`Connected to Ethereum network: ${JSON.stringify(network)}`)
        if (network.chainId === 1) {
            this.blockTimestampCache = require("../mainnet_timestamp_cache.json")
            this.log(`Loaded ${Object.keys(this.blockTimestampCache).length} block timestamps from disk`)
        }

        this.eth.on("block", blockNumber => {
            if (blockNumber % 10 === 0) { this.log(`Block ${blockNumber} observed`) }
            this.state.lastObservedBlockNumber = blockNumber
        })

        // this.state should be broken up into state.js, and rest called this.config
        this.log("Initializing Monoplasma state...")
        const savedState = config.reset ? {} : await this.store.loadState()
        this.state = Object.assign({
            adminFee: 0,
        }, savedState, config)

        // get initial state from contracts, also works as a sanity check for the config
        this.contract = new Contract(this.state.contractAddress, MonoplasmaJson.abi, this.eth)
        this.state.tokenAddress = await this.contract.token()
        this.state.adminAddress = await this.contract.owner()
        this.token = new Contract(this.state.tokenAddress, TokenJson.abi, this.eth)
        this.state.blockFreezeSeconds = (await this.contract.blockFreezeSeconds()).toString()
        this.log(`Read from contracts: freeze period = ${this.state.blockFreezeSeconds} sec, token @ ${this.state.tokenAddress}`)

        // TODO: next time a new event is added, DRY this (there's like 6 repetitions of listened events)
        this.adminFeeFilter = this.contract.filters.AdminFeeChanged()
        this.blockCreateFilter = this.contract.filters.BlockCreated()
        this.tokenTransferFilter = this.token.filters.Transfer(null, this.contract.address)

        let lastPublishedBlockNumber = this.state.lastPublishedBlock && this.state.lastPublishedBlock.blockNumber
        let lastBlock = {
            members: [],
            blockNumber: 0,
            timestamp: 0,
        }
        if (lastPublishedBlockNumber) {
            // quick fix for BigNumbers that have ended up in the store.json:
            //   they get serialized as {"_hex":"0x863a0a"}
            if (lastPublishedBlockNumber._hex) {
                lastPublishedBlockNumber = Number.parseInt(lastPublishedBlockNumber._hex)
            }
            this.log(`Reading from store lastPublishedBlockNumber ${lastPublishedBlockNumber}`)
            lastBlock = await this.store.loadBlock(lastPublishedBlockNumber)
        }

        // TODO: this.plasma should be called this.realtimeState
        this.log(`Starting from block ${lastBlock.blockNumber} (t=${lastBlock.timestamp}, ${new Date((lastBlock.timestamp || 0) * 1000).toISOString()}) with ${lastBlock.members.length} members`)
        this.plasma = new MonoplasmaState(this.state.blockFreezeSeconds, lastBlock.members, this.store, this.state.adminAddress, this.state.adminFee, lastBlock.blockNumber, lastBlock.timestamp)

        this.log("Syncing Monoplasma state...")
        const playbackStartingTimestamp = this.state.lastMessageTimestamp || 0

        this.log("Listening to joins/parts from the Channel...")

        // replay and cache messages until in sync
        // TODO: cache only starting from given block (that operator/validator have loaded state from store)
        this.channel.on("message", (type, addresses, meta) => {
            this.log(`Message received: ${type} ${addresses}`)
            const addressList = addresses.map(utils.getAddress)
            const event = { type, addressList, timestamp: meta.messageId.timestamp }
            this.messageCache.push(event)
        })
        await this.channel.listen(playbackStartingTimestamp)
        this.log(`Playing back ${this.messageCache.length} messages from joinPartStream`)

        // messages are now cached => do the Ethereum event playback, sync up this.plasma
        this.channel.on("error", this.log)
        const currentBlock = await this.eth.getBlockNumber()
        this.state.lastPublishedBlock = await this.playbackUntilBlock(currentBlock)

        // for messages from now on: add to cache but also replay directly to "realtime plasma"
        this.channel.on("message", async (type, addresses, meta) => {
            // convert incoming addresses to checksum addresses
            const addressList = addresses.map(utils.getAddress)
            const event = { type, addressList, timestamp: meta.messageId.timestamp }
            this.log(`Members ${type}: ${addressList}`)
            await replayOn(this.plasma, [event])
            this.emit(type, addresses)
        })

        this.log("Listening to Ethereum events...")
        this.contract.on(this.adminFeeFilter, async (adminFee, event) => {
            this.log(`Admin fee changed to ${utils.formatEther(adminFee)} at block ${event.blockNumber}`)
            await replayOn(this.plasma, [event])
            this.emit("adminFeeChanged", event)
        })
        this.contract.on(this.blockCreateFilter, (blockNumber, rootHash, ipfsHash, event) => {
            this.log(`Observed creation of block ${+blockNumber} at block ${event.blockNumber} (root ${rootHash}, ipfs "${ipfsHash}")`)
            this.state.lastPublishedBlock = event.args
            this.emit("blockCreated", event)
        })
        this.token.on(this.tokenTransferFilter, async (to, from, amount, event) => {
            this.log(`Received ${utils.formatEther(event.args.value)} DATA`)
            await replayOn(this.plasma, [event])
            this.emit("tokensReceived", event)
        })

        /*
        // TODO: ethers.js re-org handling
        this.tokenFilter.on("changed", event => {
            const i = this.eventQueue.findIndex(e => e.blockNumber === event.blockNumber && e.transactionIndex === event.transactionIndex)
            if (i > -1) {
                this.log(`Chain re-organization, event removed: ${JSON.stringify(event)}`)
                this.eventQueue.splice(i, 1)
            } else {
                // TODO: how to handle? This might invalidate old commits or mess the state,
                //   perhaps need to resync the whole thing (restart with config.reset=true),
                this.error(`Event removed in reorg, but not found in eventQueue: ${JSON.stringify(event)}`)
            }
        })
        this.tokenFilter.on("error", this.error)
        */

        // TODO: maybe state saving function should create the state object instead of continuously mutating "state" member
        await this.store.saveState(this.state)
    }

    async stop() {
        //this.tokenFilter.unsubscribe()
        await this.channel.close()
    }

    /**
     * Clone given state and overwrite current MonoplasmaState of the watcher
     * @param {MonoplasmaState} monoplasmaState original to be copied
     */
    setState(monoplasmaState) {
        this.plasma = new MonoplasmaState(
            this.state.blockFreezeSeconds,
            monoplasmaState.members,
            this.store,
            this.state.adminAddress,
            this.state.adminFee,
            monoplasmaState.blockNumber,
            monoplasmaState.timestamp
        )
    }

    /**
     * Advance the "committed" or "final" state which reflects the blocks committed by the operator
     * @param {Number} toBlock is blockNumber from BlockCreated event
     * @param {MonoplasmaState} plasma to sync, default is this watcher's "realtime state"
     */
    async playbackUntilBlock(toBlock, plasma) {
        if (!plasma) { plasma = this.plasma }
        const fromBlock = plasma.currentBlock + 1 || 0      // JSON RPC filters are inclusive, hence +1
        const fromTimestamp = plasma.currentTimestamp || 0
        if (toBlock <= fromBlock) {
            this.log(`Playback skipped: block ${toBlock} requested, already at ${fromBlock}`)
            return
        }
        if (fromTimestamp < this.cachePrunedUpTo) {
            throw new Error(`Cache has been pruned up to ${this.cachePrunedUpTo}, can't play back correctly ${fromTimestamp}...${toTimestamp}`)
        }
        const toTimestamp = await this.getBlockTimestamp(toBlock)

        this.log(`Retrieving from blocks ${fromBlock}...${toBlock}`)
        const adminFeeFilter = Object.assign({}, this.adminFeeFilter,  { fromBlock, toBlock })
        const blockCreateFilter = Object.assign({}, this.blockCreateFilter, { fromBlock, toBlock })
        const tokenTransferFilter = Object.assign({}, this.tokenTransferFilter,  { fromBlock, toBlock })
        const adminFeeEvents = await this.eth.getLogs(adminFeeFilter)
        const blockCreateEvents = await this.eth.getLogs(blockCreateFilter)
        const transferEvents = await this.eth.getLogs(tokenTransferFilter)

        // "if you use v5, you can use contract.queryFilter, which will include the parsed events" https://github.com/ethers-io/ethers.js/issues/37
        parseLogs(this.contract.interface, adminFeeEvents)
        parseLogs(this.contract.interface, blockCreateEvents)
        parseLogs(this.token.interface, transferEvents)

        const events = mergeEventLists(mergeEventLists(adminFeeEvents, blockCreateEvents), transferEvents)

        // TODO: maybe harvest block timestamps from provider in the background after start-up, save to store?
        //   Blocking here could last very long during first playback in case of long-lived community...
        this.log(`Retrieving block timestamps for ${events.length} events...`)
        for (const event of events) {
            event.timestamp = await this.getBlockTimestamp(event.blockNumber)
        }

        this.log(`Getting messages between ${fromTimestamp}...${toTimestamp} from cache`)
        const fromIndex = bisectFindFirstIndex(this.messageCache, msg => msg.timestamp > fromTimestamp)
        const toIndex = bisectFindFirstIndex(this.messageCache, msg => msg.timestamp > toTimestamp)
        const messages = this.messageCache.slice(fromIndex, toIndex)

        this.log(`Replaying ${events.length} events and ${messages.length} messages`)
        await replayOn(plasma, events, messages)
        plasma.currentBlock = toBlock
        plasma.currentTimestamp = toTimestamp

        // TODO: smarter way to pass this to start()
        const lastPublishedBlock = blockCreateEvents && blockCreateEvents.length > 0 ? blockCreateEvents.slice(-1)[0].args : { blockNumber: 0 }
        return lastPublishedBlock
    }

    /**
     * Prune message cache after they aren't going to be needed anymore
     * TODO: move to streamrChannel as channelPruneCache(lastRemovedTimestamp)
     * TODO: @param {Number} lastRemovedTimestamp up to which messages are dropped
     */
    channelPruneCache() {
        const lastRemovedTimestamp = this.plasma.currentTimestamp
        const keepIndex = bisectFindFirstIndex(this.messageCache, msg => msg.timestamp > lastRemovedTimestamp)
        this.messageCache = this.messageCache.slice(keepIndex)
        this.cachePrunedUpTo = lastRemovedTimestamp
    }

    /**
     * Cache the timestamps of blocks in milliseconds
     * TODO: also store the cache? It's immutable after all...
     * @param {Number} blockNumber
     */
    async getBlockTimestamp(blockNumber) {
        if (!(blockNumber in this.blockTimestampCache)) {
            this.log(`blockTimestampCache miss for block number ${blockNumber}`)
            const block = await this.eth.getBlock(blockNumber)
            this.blockTimestampCache[blockNumber] = block.timestamp * 1000
        }
        return this.blockTimestampCache[blockNumber]
    }

    /**
     * @returns {BigNumber} the number of token-wei held in the Monoplasma contract
     */
    async getContractTokenBalance() {
        const balance = await this.token.methods.balanceOf(this.state.contractAddress).call()
        return balance
    }

    /**
     * Returns the "real-time plasma" stats
     * @returns {Object} summary of different stats and config of the community the watcher is watching
     */
    getStats() {
        const joinPartStreamId = this.channel.stream.id
        const memberCount = this.plasma.getMemberCount()
        const totalEarnings = this.plasma.getTotalRevenue()
        const latestBlock = summarizeBlock(this.plasma.getLatestBlock())
        const latestWithdrawableBlock = summarizeBlock(this.plasma.getLatestWithdrawableBlock())
        return {
            memberCount,
            totalEarnings,
            latestBlock,
            latestWithdrawableBlock,
            joinPartStreamId,
        }
    }
}
