const { ContractFactory } = require("ethers")

const CommunityJson = require("../../build/CommunityProduct")

/** @typedef {string} EthereumAddress */

/**
 * Deploy a CommunityProduct contract with no real joinPartStream, for (unit) test purposes
 * @param {Wallet} wallet to do the deployment from, also becomes owner or stream and contract
 * @param {EthereumAddress} operatorAddress community-product-server that should operate the contract
 * @param {EthereumAddress} tokenAddress
 * @param {Number} blockFreezePeriodSeconds
 * @param {Function} log
 */
async function deployTestCommunity(wallet, operatorAddress, tokenAddress, blockFreezePeriodSeconds, log) {
    log && log(`Deploying DUMMY root chain contract (token @ ${tokenAddress}, blockFreezePeriodSeconds = ${blockFreezePeriodSeconds}, no joinPartStream...`)
    const deployer = new ContractFactory(CommunityJson.abi, CommunityJson.bytecode, wallet)
    const result = await deployer.deploy(operatorAddress, "dummy-stream-id", tokenAddress, blockFreezePeriodSeconds)
    await result.deployed()
    return result
}

module.exports = deployTestCommunity
