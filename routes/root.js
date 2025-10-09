const router = require('express').Router();
const jwt = require('jsonwebtoken');
const pushLog = require('../lib/pushLog');

const {Api, ErrorResponse} = require('../src/Api');
const {User, QueryBuilder, prisma} = require('../src/Model/User');

router.get('/', async function(req, res) {
    res.ejsRender('home.ejs').then(file => {
        res.clearCookie('msgs');
        res.send(file);
    }).catch(error => {
        console.error(error);
        
        pushLog(error, "rendering home");
        res.sendStatus(500).end();
    });
});

router.get('/docs', async function(req, res) {
    res.ejsRender('docs.ejs', {}, {'template': "basic"}).then(file => {
        res.clearCookie('msgs');
        res.send(file);
    }).catch(error => {
        pushLog(error, "rendering docs");
        res.sendStatus(500).end();
    });
});


router.get('/activateUser', Api.asyncHandler(async (req, res, next) => {
    let response, status_code = 200;
    if(req.query.activationToken){
        try{
            const user_verification = await prisma.user_email_verification.findUnique({
                'where': {
                    'token': req.query.activationToken
                }
            });
            if(user_verification && user_verification.reason == "activation"){
                await prisma.user_email_verification.delete({
                    'where': {
                        'token': req.query.activationToken
                    }
                });
                const user = new User({'user': {'id': user_verification.user_id}});
                await user.activate(user_verification.user_id);
                
                res.ejsRender('success_redirect.ejs', {'message': "emailVerified", 'redirect_uri': `https://${process.env.FRONTEND_DOMAIN}`}).then(file => {
                    res.send(file);
                });
            }
            else{
                try {
                    const jwt_content = jwt.verify(req.query.activationToken, process.env.SESSION_SECRET);
                    if(!isNaN(jwt_content.user_id)){
                        const user = new User();
                        const token_user = await user.get(jwt_content.user_id);
                        if(token_user.status == "active"){
                            res.ejsRender('success_redirect.ejs', {'message': "emailAlreadyVerified", 'redirect_uri': `https://${process.env.FRONTEND_DOMAIN}`}).then(file => {
                                res.send(file);
                            });
                        }
                        else {
                            if(user.status == "invalid"){
                                res.ejsRender('error.ejs', {'error_code': 404, 'error_message': "Activation link expired"}).then((file)=>{
                                    res.status(404).send(file);
                                })
                            }
                            else {
                                next();
                            }
                        }
                    }
                    else {
                        next();
                    }
                }
                catch(error){
                    pushLog("Invalid token", "User Activation", "request");
                    next();
                }
            }
        }
        catch(error){
            const qb_error = QueryBuilder.errorHandler(error);
            status_code = error.status_code || qb_error.status_code;
            response = Api.errorResponseBody(status_code, qb_error.message, error?.code);
            res.status(status_code).send(response);
        }
    }
    else{
        next();
    }
}));

// REQUEST USER PASSWORD RESET
router.post('/requestResetPassword', async function(req, res) {
    let response, status_code = 200, payload = req.body;
    try{
        if(typeof payload?.email === 'string'){
            const user = new User();
            await user.sendPasswordEmailReset(payload.email);
            response = {'status': status_code, 'message': "Password reset email sent"};
        }
        else{
            throw new ErrorResponse("email_not_string", 400, {type: typeof payload.email});
        }
    }
    catch(error){
        response = QueryBuilder.errorHandler(error, payload);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

// USER PASSWORD RESET
router.post('/resetPassword', async function(req, res, next) {
    let response, status_code = 200, payload = req.body;
    try{
        if(typeof payload?.token === 'string'){
            if(typeof payload?.password === 'string'){
                const user_verification = await prisma.user_email_verification.findUnique({
                    'where': {
                        'token': payload?.token,
                        'reason': "password_reset"
                    },
                    'include': {
                        'user': true
                    }
                });
                if(user_verification){
                    const user = new User({'user': user_verification.user});
                    const password_change = await user.changePassword(user_verification.user_id, payload?.password);
                    if(password_change){
                        await prisma.user_email_verification.delete({
                            'where': {
                                'id': user_verification.id
                            }
                        });
                        response = {'status': status_code, 'message': "Password has been changed successfully"};
                    }
                    else{
                        throw new ErrorResponse("password_change_failed", 400);
                    }
                }
                else{
                    throw new ErrorResponse("token_invalid", 400);
                }
            }
            else{
                throw new ErrorResponse("password_not_string", 400, {type: typeof payload.password});
            }
        }
        else{
            throw new ErrorResponse("token_not_string", 400, {type: typeof payload.token});
        }
    }
    catch(error){
        response = QueryBuilder.errorHandler(error, payload);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});


module.exports = router;