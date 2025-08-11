const router = require('express').Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const {User, prisma} = require('../../../src/Model/User');
const {RateLimiter, ErrorResponse} = require('../../../src/Api');
const api_credentials = require('../../../data/api_credentials');
const pushLog = require('../../../lib/pushLog');

router.all('*', async function(req, res, next) {
    const auth = req.headers.authorization ? Buffer.from(req.headers.authorization.split(' ')[1], 'base64').toString('utf8') : null;
    if(!auth){
        throw new ErrorResponse("Authentication credentials missing", 401);
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
            if(user.status != "active"){
                status_code = 403;
                if(user.status == "inactive"){
                    throw new ErrorResponse("Your account has been suspended", 403);
                }
                if(user.status == "invited"){
                    throw new ErrorResponse("Email address hasn't been verified yet", 403);
                }
            }
            if(await bcrypt.compare(password, user?.hash)){
                req.user = user;
                delete req.user.hash;
            }
            else{
                throw new ErrorResponse("Authentication failed: invalid credentials", 401);
            }
        }
        else{
            throw new ErrorResponse("Authentication failed: invalid credentials", 401);
        }
        next();
    }
    catch(error){
        const response = error instanceof ErrorResponse ? error.toJSON() : error.toString();
        status_code = response?.status_code || 500;
        res.status(status_code).send(response);
    }
});

// Usage of custom limiter
if(process.env.NODE_ENV == "production"){
    const rateLimiter = new RateLimiter();
    const apiRateLimiter = rateLimiter.createLimiter();

    router.use(apiRateLimiter);
}

router.get('/', async (req, res) =>{
    res.ejsRender('home.ejs', {}).then(file => {
        res.clearCookie('msgs');
        res.send(file);
    }).catch(error => {
        pushLog(error, "rendering home");
        res.sendStatus(500).end();
    });
});

module.exports = router;