const { db } = require('../../config/database');

class BaseModel {
    constructor(tableName) {
        this.tableName = tableName;
        this._trx = null;
    }

    get db() {
        return db();
    }

    // فعال کردن تراکنش برای مدل
    withTransaction(trx) {
        const instance = Object.create(this);
        instance._trx = trx;
        return instance;
    }

    query() {
        return this._trx ? this._trx(this.tableName) : this.db(this.tableName);
    }

    async create(data) {
        const [result] = await this.query().insert(data).returning('*');
        return result;
    }

    async insertMany(dataArray) {
        return await this.query().insert(dataArray).returning('*');
    }

    async find(conditions = {}) {
        let query = this.query();
        Object.keys(conditions).forEach(key => {
            if (conditions[key] !== undefined) {
                if (Array.isArray(conditions[key])) {
                    query = query.whereIn(key, conditions[key]);
                } else {
                    query = query.where(key, conditions[key]);
                }
            }
        });
        return await query;
    }

    async findOne(conditions = {}) {
        const results = await this.find(conditions);
        return results[0] || null;
    }

    async findById(id) {
        return await this.query().where('id', id).first();
    }

    async updateMany(conditions, updateData) {
        let query = this.query();
        Object.keys(conditions).forEach(key => {
            if (conditions[key] !== undefined) {
                if (Array.isArray(conditions[key])) {
                    query = query.whereIn(key, conditions[key]);
                } else {
                    query = query.where(key, conditions[key]);
                }
            }
        });
        return await query.update(updateData).returning('*');
    }

    async findByIdAndUpdate(id, updateData) {
        const [result] = await this.query()
            .where('id', id)
            .update(updateData)
            .returning('*');
        return result;
    }

    async deleteMany(conditions) {
        let query = this.query();
        Object.keys(conditions).forEach(key => {
            if (conditions[key] !== undefined) {
                if (Array.isArray(conditions[key])) {
                    query = query.whereIn(key, conditions[key]);
                } else {
                    query = query.where(key, conditions[key]);
                }
            }
        });
        return await query.del();
    }

    async countDocuments(conditions = {}) {
        let query = this.query();
        Object.keys(conditions).forEach(key => {
            if (conditions[key] !== undefined) {
                query = query.where(key, conditions[key]);
            }
        });
        const result = await query.count('* as count');
        return parseInt(result[0].count);
    }

    // گرفتن آمار گروه‌بندی شده
    async groupCount(column) {
        try {
            const results = await this.query()
                .select(column)
                .count('* as count')
                .groupBy(column);

            return results.map(row => ({
                _id: row[column],
                count: parseInt(row.count, 10)
            }));
        } catch (error) {
            console.error(`❌ Error in groupCount for table ${this.tableName}:`, error);
            throw error;
        }
    }

    // در BaseModel
    async deleteMany(conditions) {
        let query = this.query();

        Object.keys(conditions).forEach(key => {
            if (conditions[key] !== undefined) {
                if (typeof conditions[key] === 'object' && conditions[key] !== null) {
                    // پشتیبانی از operators مثل { createdAt: { '<': date } }
                    Object.keys(conditions[key]).forEach(operator => {
                        switch (operator) {
                            case '<':
                                query = query.where(key, '<', conditions[key][operator]);
                                break;
                            case '>':
                                query = query.where(key, '>', conditions[key][operator]);
                                break;
                            // سایر operators...
                        }
                    });
                } else if (Array.isArray(conditions[key])) {
                    query = query.whereIn(key, conditions[key]);
                } else {
                    query = query.where(key, conditions[key]);
                }
            }
        });

        return await query.del();
    }
}

module.exports = BaseModel;