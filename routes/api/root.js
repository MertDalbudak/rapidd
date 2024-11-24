const router = require('express').Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const {prisma} = require('../../src/QueryBuilder');
const api_credentials = require('../../data/api_credentials');
const pushLog = require('../../lib/pushLog');

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
                    },
                    'include': {
                        'student': true,
                        'teacher': true
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
    console.log(req.body);
    
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
        console.log(user);
        if(user){
            if(user.status != "active"){
                status_code = 403;
                if(user.status == "inactive"){
                    throw new Error("Your account has been suspended");
                }
                if(user.status == "invited"){
                    throw new Error("Email address hasn't been verified yet");
                }
            }
            if(await bcrypt.compare(req.body.password, user?.hash)){
                const token = jwt.sign({ user_id: user.id }, process.env.SESSION_SECRET, { expiresIn: '1h' });
                const expiration = Date.now() + 60 * 60 * 1000; // 1 hour expiration
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

router.post('/logout', async (req, res)=>{
    let response, status_code = 200;
    try{
        if(req.session == null){
            status_code = 400;
            throw new Error('No active session');
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