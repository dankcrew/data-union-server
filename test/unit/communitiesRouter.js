const os = require("os")
const path = require("path")
const express = require("express")
const bodyParser = require("body-parser")
const assert = require("assert")
const http = require("http")
const fetch = require("node-fetch")
const { Wallet, ContractFactory, providers: { Web3Provider } } = require("ethers")

const CommunityJson = require("../../build/CommunityProduct")
const TokenJson = require("../../build/TestToken")

const ganache = require("ganache-core")

const { until } = require("../utils/await-until")

const MockStreamrChannel = require("../utils/mockStreamrChannel")
const mockStore = require("monoplasma/test/utils/mockStore")
const log = console.log  // () => {}
const members = [
    { address: "0x2F428050ea2448ed2e4409bE47e1A50eBac0B2d2", earnings: "50" },
    { address: "0xb3428050ea2448ed2e4409be47e1a50ebac0b2d2", earnings: "20" },
]
const initialBlock = {
    blockNumber: 3,
    members,
    totalEarnings: 70,
    timestamp: Date.now(),
}
const startState = {
    lastBlockNumber: 5,
    lastPublishedBlock: {
        blockNumber: 3
    }
}

const CommunityProductServer = require("../../src/server")
const getCommunitiesRouter = require("../../src/routers/communities")

describe("Community product server /communities router", () => {
    const port = 3031
    const serverURL = `http://localhost:${port}`

    let httpServer
    let token
    let community
    let channel
    before(async function() {
        this.timeout(5000)
        const secretKey = "0x1234567812345678123456781234567812345678123456781234567812345678"
        const provider = new Web3Provider(ganache.provider({
            accounts: [{ secretKey, balance: "0xffffffffffffffffffffffffff" }],
            logger: { log },
        }))
        const wallet = new Wallet(secretKey, provider)
        await provider.getNetwork()     // wait until ganache is up and ethers.js ready

        // "start from" block 10
        for (let i = 0; i < 10; i++) {
            await provider.send("evm_mine")
        }

        log("Deploying test token and Community contract...")
        const tokenDeployer = new ContractFactory(TokenJson.abi, TokenJson.bytecode, wallet)
        token = await tokenDeployer.deploy("Router test token", "TEST")
        await token.deployed()

        const deployer = new ContractFactory(CommunityJson.abi, CommunityJson.bytecode, wallet)
        const contract = await deployer.deploy(wallet.address, "dummy-stream-id", token.address, 1000, 0)
        await contract.deployed()
        const contractAddress = contract.address

        log("Starting CommunityProductServer...")
        const storeDir = path.join(os.tmpdir(), `communitiesRouter-test-${+new Date()}`)
        const server = new CommunityProductServer(wallet, storeDir, {
            tokenAddress: token.address,
            operatorAddress: wallet.address,
        })
        channel = new MockStreamrChannel(secretKey, "dummy-stream-for-router-test")
        server.getStoreFor = () => mockStore(startState, initialBlock, log)
        server.getChannelFor = () => channel
        const router = getCommunitiesRouter(server, log)
        community = await server.startOperating(contractAddress)

        log("Starting CommunitiesRouter...")
        const app = express()
        app.use(bodyParser.json())
        app.use("/communities", router)
        httpServer = http.createServer(app)
        httpServer.listen(port)
    })

    it("GET /", async () => {
        const resp = await fetch(`${serverURL}/communities/${community.address}`).then(res => res.json())
        assert.strictEqual(resp.status, "ok")
    })

    it("GET /stats", async () => {
        const stats = await fetch(`${serverURL}/communities/${community.address}/stats`).then(res => res.json())
        assert.strictEqual(stats.memberCount.active, 2)
    })

    it("GET /members", async () => {
        const memberList = await fetch(`${serverURL}/communities/${community.address}/members`).then(res => res.json())
        assert.strictEqual(memberList.length, 2)
    })

    it("GET /members/address", async () => {
        const member = await fetch(`${serverURL}/communities/${community.address}/members/${members[0].address}`).then(res => res.json())
        assert.strictEqual(member.earnings, "50")
    })

    it("GET /members/non-existent-address", async () => {
        const res = await fetch(`${serverURL}/communities/${community.address}/members/0x0000000000000000000000000000000000000001`)
        assert.strictEqual(res.status, 404)
    })

    // Test the case where the member is in the community but too new to have earnings in withdrawable blocks
    // Catch the following:
    //   UnhandledPromiseRejectionWarning: Error: Address 0x0000000000000000000000000000000000000002 not found!
    //   at MerkleTree.getPath (node_modules/monoplasma/src/merkletree.js:121:19)
    //   at MonoplasmaState.getProof (node_modules/monoplasma/src/state.js:153:32)
    //   at MonoplasmaState.getMember (node_modules/monoplasma/src/state.js:129:26)
    //   at router.get (src/routers/communities.js:96:31)
    it("GET /members/new-member-address", async () => {
        const newMemberAddress = "0x0000000000000000000000000000000000000002"
        channel.publish("join", [newMemberAddress])
        await until(async () => {
            const memberList = await fetch(`${serverURL}/communities/${community.address}/members`).then(res => res.json())
            return memberList.length > 2
        })
        const member = await fetch(`${serverURL}/communities/${community.address}/members/${newMemberAddress}`).then(res => res.json())
        assert(!member.error)
        assert.strictEqual(member.withdrawableEarnings, "0")
    })

    after(() => {
        httpServer.close()
    })
})
