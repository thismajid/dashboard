const BaseModel = require('./BaseModel');

class AccountModel extends BaseModel {
    constructor() {
        super('Accounts');
    }

    async getAccountStats() {
        try {
            const stats = await this.groupCount('status');

            const accountStats = {
                total: 0,
                pending: 0,
                processing: 0,
                completed: 0,
                good: 0,
                bad: 0,
                invalid: 0,
                '2fa': 0,
                passkey: 0,
                error: 0
            };

            stats.forEach(stat => {
                const statusKey = stat._id;
                const count = stat.count;

                accountStats.total += count;

                if (accountStats.hasOwnProperty(statusKey)) {
                    accountStats[statusKey] = count;
                }

                if (['good', 'bad', 'invalid', '2fa', 'passkey', 'error'].includes(statusKey)) {
                    accountStats.completed += count;
                }
            });

            return accountStats;
        } catch (error) {
            console.error('❌ خطا در دریافت آمار اکانت‌ها:', error);
            return {
                total: 0, pending: 0, processing: 0, completed: 0,
                good: 0, bad: 0, invalid: 0, '2fa': 0, passkey: 0, error: 0
            };
        }
    }
}

module.exports = new AccountModel();