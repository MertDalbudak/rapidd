const router = require('express').Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const {User, prisma} = require('../../../src/Model/User');
const {RateLimiter, ErrorResponse} = require('../../../src/Api');
const api_credentials = require('../../../data/api_credentials');
const pushLog = require('../../../lib/pushLog');

router.all('*', async function(req, res, next) {
    const auth = req.headers.authorization ? Buffer.from(req.headers.authorization.split(' ')[1], 'base64').toString('utf8') : null;
    if(process.env.UNRESTRICTED_API === "TRUE" || (api_credentials.findIndex((e) => e.user.concat(':', e.pass) == auth)) > -1){
        req.session = null;
        req.user = null;
        if(req.headers['x-session-token'] != undefined){
            req.session = await prisma.session.findFirst({
                'where': {
                    'token': req.headers['x-session-token']
                }
            });
            if(req.session != null){
                req.user = await prisma.user.findUnique({
                    'where': {
                        'id': req.session.user_id
                    }
                });
            }
        }
        next();
    }
    else{
        res.ejsRender('error.ejs', {'error_code': 401}).then(file => {
            res.status(401).send(file);
        });
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

router.post('/login', async (req, res)=>{
    let response, status_code = 200;
    
    createSession: try{
        let user = await prisma.user.findUnique({
            where:{
                'username': req.body.user
            },
            select: {
                'id': true,
                'status': true,
                'hash': true
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
            if(await bcrypt.compare(req.body.password, user?.hash)){
                const token = jwt.sign({ 'user_id': user.id, 'timestamp': new Date().getTime() }, process.env.SESSION_SECRET, { expiresIn: '24h' });
                const expiration = Date.now() + parseInt(process.env.SESSION_MAX_AGE);
                await prisma.session.create({
                    'data':{
                        'user_id': user.id,
                        'token': token,
                        'expires_at': new Date(expiration)
                    }
                });
                response = {
                    'status': "success",
                    'session_token': token
                }
                break createSession;
            }
        }
        status_code = 401;
        response = {
            'status': "failed",
            'message': "Username or password is not valid"
        }
    }
    catch(error){
        console.error(error);
        status_code = status_code != 200 ? status_code : 500;
        response = {'status_code': status_code, 'message': error.toString()};
    }
    res.status(status_code).send(response);
});

// RESEND ACTIVATION

router.post('/resendActivation', async (req, res)=>{
    let response, status_code = 200, payload = req.body;
    try {
        let user;
        if(payload.user.includes('@')){
            user = await prisma.user.findUnique({
                'select': {'id': true},
                'where': {
                    'email': payload.user,
                    'status': "invited"
                }
            });
        }
        else{
            user = await prisma.user.findUnique({
                'select': {'id': true},
                'where': {
                    'username': payload.user,
                    'status': "invited"
                }
            });
        }
        if(user){
            const user_id = user.id;
            user = new User({'user_id': user.id});
            await user.sendValidationMail(user_id, "activation");

            response = {
                'status': "success",
                'message': "Activation mail has been send"
            }
        }
        else{
            status_code = 404;
            throw new ErrorResponse("User not found", 404);
        }
    }
    catch(error){
        console.error(error);
        status_code = status_code != 200 ? status_code : 500;
        response = {'status_code': status_code, 'message': error.toString()};
    }
    res.status(status_code).send(response);
});

router.post('/logout', async (req, res)=>{
    let response, status_code = 200;
    try{
        if(req.session == null){
            status_code = 400;
            throw new ErrorResponse('No active session', 401);
        }
        await prisma.session.delete({
            'where': {
                'token': req.session.token
            }
        });
        response = {
            'status': "success",
            'message': "Session token has been terminated"
        }
    }
    catch(error){
        console.error(error);
        status_code = status_code != 200 ? status_code : 500;
        response = {'status_code': status_code, 'message': error.toString()};
    }
    res.status(status_code).send(response);
});

module.exports = router;