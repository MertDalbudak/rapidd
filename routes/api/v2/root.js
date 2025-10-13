const router = require('express').Router();
const bcrypt = require('bcrypt');
const {User, prisma} = require('../../../src/Model/User');
const {rateLimitMiddleware} = require('../../../src/Api');
const pushLog = require('../../../lib/pushLog');

// Apply rate limiting in production BEFORE authentication to protect database
if(process.env.NODE_ENV == "production"){
    router.use(rateLimitMiddleware());
}

router.all('*', async function(req, res, next) {
    const auth = req.headers.authorization ? Buffer.from(req.headers.authorization.split(' ')[1], 'base64').toString('utf8') : null;
    if(!auth){
        const message = req.getTranslation("auth_credentials_missing");
        return res.sendError(401, message);
    }
    const [username, password] = auth.split(':');
    req.user = null;
    try{
        const user = await prisma.user.findUnique({
            where:{
                'username': username,
                'api_user': true
            },
            omit: {
                'hash': false
            }
        });
        if(user){
            if(user.status == "inactive"){
                const message = req.getTranslation("account_suspended");
                return res.sendError(403, message);
            }
            if(user.status == "invited"){
                const message = req.getTranslation("email_not_verified");
                return res.sendError(403, message);
            }
            if(await bcrypt.compare(password, user?.hash)){
                req.user = user;
                delete req.user.hash;
            }
            else{
                const message = req.getTranslation("auth_failed_invalid_credentials");
                return res.sendError(401, message);
            }
        }
        else{
            const message = req.getTranslation("auth_failed_invalid_credentials");
            return res.sendError(401, message);
        }
        next();
    }
    catch(error){
        const status_code = 500;
        res.status(status_code).send({status_code, message: error.toString()});
    }
});

module.exports = router;