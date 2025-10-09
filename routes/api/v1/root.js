const router = require('express').Router();
const jwt = require('jsonwebtoken');
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
    req.session = null;
    req.user = null;
    if(req.headers['x-session-token'] != undefined){
        req.session = await prisma.session.findFirst({
            'where': {'token': req.headers['x-session-token']},
            'include': {'user': true}
        });
        if(req.session != null){
            req.user = req.session.user;
        }
    }
    next();
});

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
            if(user.status == "inactive"){
                const message = req.getTranslation("account_suspended");
                return res.sendError(403, message);
            }
            if(user.status == "invited"){
                const message = req.getTranslation("email_not_verified");
                return res.sendError(403, message);
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
            const message = req.getTranslation("user_not_found");
            return res.sendError(404, message);
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
            const message = req.getTranslation("no_active_session");
            return res.sendError(401, message);
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