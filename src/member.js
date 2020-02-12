const BN = require("bn.js")
const {utils: { isAddress }} = require("web3")

module.exports = class MonoplasmaMember {
    constructor(name, address, earnings, active = true) {
        this.name = name || ""
        this.address = MonoplasmaMember.validateAddress(address)
        this.earnings = earnings ? new BN(earnings) : new BN(0)
        this.active = !!active
    }

    getEarningsAsString() {
        return this.earnings.toString(10)
    }

    getEarningsAsInt() {
        return this.earnings.toNumber()
    }

    addRevenue(amount) {
        this.earnings = this.earnings.add(new BN(amount))
    }

    isActive() {
        return !!this.active
    }

    /**
     * @param {boolean} activeState true if active, false if not going to be getting revenues
     */
    setActive(activeState) {
        this.active = !!activeState
    }

    toObject() {
        const obj = {
            address: this.address,
            earnings: this.earnings.toString(10),
            active: !!this.active
        }
        if (this.name) {
            obj.name = this.name
        }
        return obj
    }

    static fromObject(obj) {
        return new MonoplasmaMember(obj.name, obj.address, obj.earnings, obj.active)
    }

    /** Produces a hashable string representation in hex form (starts with "0x") */
    // TODO: move to merkletree.js:hashLeaf
    toHashableString() {
        return this.address + this.earnings.toString(16, 64)
    }

    async getProof(tree) {
        return this.earnings.gt(new BN(0)) ? await tree.getPath(this.address) : []
    }

    static getHashableString(address, earnings) {
        return address + earnings.toString(16, 64)
    }

    static validateAddress(address) {
        let extended = address
        if (address.length === 40) {
            extended = `0x${address}`
        }
        if (!isAddress(extended)) {
            throw new Error(`Bad Ethereum address: ${address}`)
        }
        return extended
    }
}
