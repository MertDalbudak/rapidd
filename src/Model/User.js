const {Model, QueryBuilder, prisma} = require('../Model');
const {rls} = require('../../rapidd/rapidd');

class User extends Model {
    constructor(options){
        super('user', options);
    }

    static queryBuilder = new QueryBuilder('user', rls.model.user || {});

    static getAccessFilter(user) {
        return rls.model.user?.getAccessFilter?.(user) || {};
    }

    static hasAccess(data, user) {
        return rls.model.user?.hasAccess?.(data, user) || true;
    }

    /**
     * @param {string} q
     * @property {string|Object} include
     * @param {number} limit
     * @param {number} offset
     * @param {string} sortBy
     * @param {'asc'|'desc'} sortOrder
     * @returns {Object[]}
     */
    async getMany(q = {}, include = "", limit = 25, offset = 0, sortBy = "id", sortOrder = "asc"){
        return await this._getMany(q, include, Number(limit), Number(offset), sortBy, sortOrder);
    }

    /**
     * @param {number} id
     * @param {string | Object} include
     * @returns {{} | null}
     */
    async get(id, include){
        return await this._get(Number(id), include);
    }

    /**
     * @param {Object} data
     * @returns  {Object}
     */
    async create(data){
        return await this._create(data);
    }

    /**
     * @param {number} id
     * @param {{}} data
     * @returns {Object}
     */
    async update(id, data){
        return await this._update(Number(id), data);
    }

    /**
     * @param {number} id
     * @returns {Object}
     */
    async delete(id){
        return await this._delete(Number(id));
    }

    /**
     * @param {string | Object} include
     * @returns {Object}
     */
    filter(include){
        return {...this._filter(include), ...this.getAccessFilter()};
    }

    /**
     * @param {string | Object} include
     * @returns {Object}
     */
    include(include){
        return this._include(include);
    }
}

module.exports = {User, QueryBuilder, prisma};
