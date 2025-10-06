const { PrismaClient, Prisma } = require('../prisma/client');
const rls = require('./rls');

const prisma = new PrismaClient({
    'omit': {
        'user': {
            'hash': true
        }
    }
});

module.exports = {prisma, Prisma, rls};