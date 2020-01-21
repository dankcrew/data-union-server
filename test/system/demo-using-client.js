const { spawn } = require("child_process")
const fetch = require("node-fetch")
const assert = require("assert")

const log = require("debug")("CPS::test::system::streamr-client")

const StreamrClient = require("streamr-client")

const {
    Contract,
    utils: { parseEther, formatEther, getAddress, computeAddress },
    Wallet,
    providers: { JsonRpcProvider }
} = require("ethers")

const sleep = require("../../src/utils/sleep-promise")
const { untilStreamContains } = require("../utils/await-until")
const deployCommunity = require("../../src/utils/deployCommunity")

const ERC20Mintable = require("../../build/ERC20Mintable.json")
const CommunityProduct = require("../../build/CommunityProduct.json")

const STORE_DIR = __dirname + `/test-store-${+new Date()}`
const BLOCK_FREEZE_SECONDS = 1
const ADMIN_FEE = 0.2

const {
    STREAMR_WS_URL,
    STREAMR_HTTP_URL,
    STREAMR_NODE_ADDRESS,
    ETHEREUM_SERVER,
    OPERATOR_PRIVATE_KEY,
    ADMIN_PRIVATE_KEY,
    TOKEN_ADDRESS,
    WEBSERVER_PORT,
} = require("../integration/CONFIG")

/**
 * Same as community-product-demo.js except only using StreamrClient.
 * Only needs to run against streamr-ganache docker, so uses ETHEREUM_SERVER from CONFIG
 */

// NB: THIS TEST WON'T ACTUALLY RUN BEFORE STUFF IS ADDED TO streamr-javascript-client
// TODO: add client.createProduct to streamr-javascript-client
// TODO: add client.updateProduct to streamr-javascript-client
describe.skip("Community product demo but through a running E&E instance", () => {
    let operatorProcess

    before(() => {
        log(`Creating store directory ${STORE_DIR}`)
        spawn("mkdir", ["-p", STORE_DIR])
    })

    after(() => {
        log(`Cleaning up store directory ${STORE_DIR}`)
        spawn("rm", ["-rf", STORE_DIR])
    })

    async function startServer() {
        log("--- Running start_server.js ---")
        operatorProcess = spawn(process.execPath, ["scripts/start_server.js"], {
            env: {
                STREAMR_WS_URL,
                STREAMR_HTTP_URL,
                ETHEREUM_SERVER,
                OPERATOR_PRIVATE_KEY,
                TOKEN_ADDRESS,
                STORE_DIR,
                WEBSERVER_PORT,
                BLOCK_FREEZE_SECONDS,
                RESET: "yesplease",
            }
        })
        operatorProcess.stdout.on("data", data => { log(`<server> ${data.toString().trim()}`) })
        operatorProcess.stderr.on("data", data => { log(`server *** ERROR: ${data}`) })
        operatorProcess.on("close", code => { log(`start_server.js exited with code ${code}`) })
        operatorProcess.on("error", err => {
            log(`start_server.js ERROR: ${err}`)
            process.exit(1)
        })

        await untilStreamContains(operatorProcess.stdout, "[DONE]")

        return {
            ganacheProvider: new JsonRpcProvider(ETHEREUM_SERVER),
            operatorPrivateKey: OPERATOR_PRIVATE_KEY,
            privateKey: ADMIN_PRIVATE_KEY,
        }
    }

    // for pre-started start_server.js, so to be able to debug also the server in IDE while running tests
    async function connectToLocalGanache() {    //eslint-disable-line no-unused-vars
        return {
            ganacheProvider: new JsonRpcProvider("http://localhost:8545"),
            operatorPrivateKey: "0x5e98cce00cff5dea6b454889f359a4ec06b9fa6b88e9d69b86de8e1c81887da0",  // ganache 0
            privateKey: "0xe5af7834455b7239881b85be89d905d6881dcb4751063897f12be1b0dd546bdb", // ganache 1
        }
    }

    it("should get through the happy path", async function () {
        this.timeout(10 * 60 * 1000)

        const {
            ganacheProvider,
            operatorPrivateKey,
            privateKey,
        } = await startServer()
        //} = await connectToLocalGanache()

        const address = computeAddress(privateKey)

        log("--- Server started, getting the operator config ---")

        // TODO: eliminate direct server communication (use /stats? Change EE?)
        // TODO: maybe just hard-code the correct config into CONFIG.js?
        const config = await fetch("http://localhost:8085/config").then(resp => resp.json())
        log(config)

        log(`Moving 50 tokens to ${address} for testing...`)
        const operatorWallet = new Wallet(operatorPrivateKey, ganacheProvider)
        const operatorToken = new Contract(config.tokenAddress, ERC20Mintable.abi, operatorWallet)
        log("check minter:", await operatorToken.isMinter(operatorWallet.address))
        const transferTx = await operatorToken.mint(address, parseEther("50"))
        await transferTx.wait(1)

        log("1) Create a new Community product")

        const client = new StreamrClient({
            auth: { privateKey },
            url: STREAMR_WS_URL,
            restUrl: STREAMR_HTTP_URL,
        })

        log("1.1) Create a stream that's going to go into the product")
        const streamJson = {
            "name": "Community Product server test stream " + Date.now(),
            "description": "PLEASE DELETE ME, I'm a Community Product server test stream",
            "config": {
                "fields": [{
                    "name": "string",
                    "type": "number",
                }]
            }
        }
        const stream = await client.createStream(streamJson)
        log(`     Response: ${JSON.stringify(stream)}`)

        log("1.3) Create product in the database")
        const productJson = {
            "name": "Community Product server test product " + Date.now(),
            "description": "PLEASE DELETE ME, I'm a Community Product server test product",
            "imageUrl": "https://www.streamr.com/uploads/to-the-moon.png",
            "category": "other",        // TODO: curiously, test-category-id doesn't exist in docker mysql
            "streams": [ stream.id ],
            "previewStream": stream.id,
            "previewConfigJson": "string",
            "ownerAddress": address,
            "beneficiaryAddress": address,
            "pricePerSecond": 5,
            "priceCurrency": "DATA",
            "minimumSubscriptionInSeconds": 0,
            "type": "COMMUNITY",
        }
        const productCreateResponse = await client.createProduct(productJson)
        log(`     Response: ${JSON.stringify(productCreateResponse)}`)
        const productId = productCreateResponse.id
        assert(productId)

        log("1.4) Create joinPartStream")   // done inside deployCommunity below
        log("1.5) Deploy CommunityProduct contract")
        const wallet = new Wallet(privateKey, ganacheProvider)
        const nodeAddress = getAddress(STREAMR_NODE_ADDRESS)
        const communityContract = await deployCommunity(wallet, config.operatorAddress, config.tokenAddress, nodeAddress, BLOCK_FREEZE_SECONDS, ADMIN_FEE, config.streamrWsUrl, config.streamrHttpUrl)
        const communityAddress = communityContract.address

        log("1.6) Wait until Operator starts")
        let stats = { code: true }
        const statsTimeout = setTimeout(() => { throw new Error("Response from E&E: " + JSON.stringify(stats)) }, 100000)
        let sleepTime = 100
        while (stats.code) {
            await sleep(sleepTime *= 2)
            stats = await client.getCommunityStats(communityAddress)
        }
        clearTimeout(statsTimeout)
        log(`     Stats before adding: ${JSON.stringify(stats)}`)

        log("1.7) Set beneficiary in Product DB entry")
        productJson.beneficiaryAddress = communityAddress
        const putResponse = await client.updateProduct(productJson)
        log(`     Response: ${JSON.stringify(putResponse)}`)

        log("2) Add members")
        const memberKeys = [privateKey,
            "0x0000000000000000000000000000000000000000000000000000000000000001",
            "0x0000000000000000000000000000000000000000000000000000000000000002",
            "0x0000000000000000000000000000000000000000000000000000000000000003",
            "0x0000000000000000000000000000000000000000000000000000000000000004",
            "0x0000000000000000000000000000000000000000000000000000000000000005",
            "0x0000000000000000000000000000000000000000000000000000000000000006",
            "0x0000000000000000000000000000000000000000000000000000000000000007",
            "0x0000000000000000000000000000000000000000000000000000000000000008",
            "0x0000000000000000000000000000000000000000000000000000000000000009",
        ]

        log("2.1) Add community secret")
        const secretCreateResponse = await client.createSecret(communityAddress, "test", "PLEASE DELETE ME, I'm a Community Product server test secret")
        log(`     Response: ${JSON.stringify(secretCreateResponse)}`)

        log("2.2) Send JoinRequests")
        for (const privateKey of memberKeys) {
            const tempClient = new StreamrClient({
                auth: { privateKey },
                url: STREAMR_WS_URL,
                restUrl: STREAMR_HTTP_URL,
            })
            const joinResponse = await tempClient.joinCommunity(communityAddress, "test")
            log(`     Response: ${JSON.stringify(joinResponse)}`)
        }

        log("2.3) Wait until members have been added")
        const member9address = computeAddress(memberKeys[9])
        await client.hasJoined(communityAddress, member9address)

        // TODO: send revenue by purchasing the product on Marketplace
        log("3) Send revenue in and check tokens were distributed")
        const token = new Contract(config.tokenAddress, ERC20Mintable.abi, wallet)
        for (let i = 0; i < 5; i++) {
            const balance = await token.balanceOf(address)
            log(`   Sending 10 tokens (out of remaining ${formatEther(balance)}) to CommunityProduct contract...`)

            const transferTx = await token.transfer(communityAddress, parseEther("10"))
            await transferTx.wait(2)

            // check total revenue
            const res3 = await client.getCommunityStats(communityAddress)
            log(`   Total revenue: ${formatEther(res3.totalEarnings)}`)
        }

        log("3.1) Wait for blocks to unfreeze...") //... and also that state updates.
        const before = await client.getMemberStats(communityAddress)
        let member = { withdrawableEarnings: 0 }
        // TODO: what's the expected final withdrawableEarnings?
        while (member.withdrawableEarnings < 1 + before.withdrawableEarnings) {
            await sleep(1000)
            member = await client.getMemberStats(communityAddress)
            log(JSON.stringify(member))
        }

        log("4) Withdraw tokens")

        const balanceBefore = await token.balanceOf(address)
        log(`   Token balance before: ${formatEther(balanceBefore)}`)

        const contract = new Contract(communityAddress, CommunityProduct.abi, wallet)
        const withdrawTx = await contract.withdrawAll(member.withdrawableBlockNumber, member.withdrawableEarnings, member.proof)
        await withdrawTx.wait(1)

        const res4b = await client.getMemberStats(communityAddress)
        log(JSON.stringify(res4b))

        const balanceAfter = await token.balanceOf(address)
        log(`   Token balance after: ${formatEther(balanceAfter)}`)

        const difference = balanceAfter.sub(balanceBefore)
        log(`   Withdraw effect: ${formatEther(difference)}`)

        assert(difference.eq(parseEther("5")))
    })

    afterEach(() => {
        if (operatorProcess) {
            operatorProcess.kill()
            operatorProcess = null
        }
    })
})
