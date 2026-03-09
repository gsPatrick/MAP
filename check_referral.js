// check_referral.js
const { Client, Subscription, Plan } = require('./src/database');
const { Op } = require('sequelize');

async function check() {
    try {
        const latestReferralSub = await Subscription.findOne({
            where: { status: 'Ativa' },
            include: [
                {
                    model: Client,
                    as: 'client',
                    where: { referredByClientId: { [Op.ne]: null } },
                    required: true,
                    include: [{ model: Client, as: 'referrer' }]
                },
                { model: Plan, as: 'plan' }
            ],
            order: [['createdAt', 'DESC']]
        });

        if (!latestReferralSub) {
            console.log('NOT_FOUND: No recent referral subscription found.');
            return;
        }

        const { client, plan } = latestReferralSub;
        const affiliate = client.referrer;

        console.log('RESULT_START');
        console.log(`SUBSCRIBER_NAME: ${client.name}`);
        console.log(`SUBSCRIBER_ID: ${client.id}`);
        console.log(`PLAN_NAME: ${plan.name}`);
        console.log(`COMMISSION_VAL: ${plan.affiliateCommissionValue}`);
        console.log(`AFFILIATE_NAME: ${affiliate.name}`);
        console.log(`AFFILIATE_ID: ${affiliate.id}`);
        console.log(`AFFILIATE_BALANCE: ${affiliate.balance}`);
        console.log(`CREATED_AT: ${latestReferralSub.createdAt}`);
        console.log('RESULT_END');

    } catch (error) {
        console.error('ERROR_START');
        console.error(error);
        console.error('ERROR_END');
    } finally {
        process.exit();
    }
}

check();
