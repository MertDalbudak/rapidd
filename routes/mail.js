const router = require('express').Router();
const pushLog = require('../lib/pushLog');

const {Api, ErrorResponse} = require('../src/Api');
const {User, QueryBuilder, prisma} = require('../src/Model/User');

router.get('/activation', async (req, res, next) => {
    if(req.query.activationToken){
        const user_verification = await prisma.user_email_verification.findUnique({
            'where': {
                'token': req.query.activationToken
            },
            'include': {
                'user': true
            }
        });
        if(user_verification && user_verification.reason == "activation"){
            user_verification.viewInBrowser = `https://${process.env.DOMAIN}/mail/activation?activationToken=${user_verification.token}`;
            user_verification.activation_uri = `https://${process.env.DOMAIN}/activateUser?activationToken=${user_verification.token}`;
            res.ejsRender('confirmation.ejs', {...user_verification}, {'language': "de-de", 'template': "email"}).then(file => {
                res.send(file);
            }).catch(error => {
                pushLog(error, `Rendering activation mail for ${user_verification.user.username}`);
                res.status(500).send(error);
            });
        }
        else{
            next();
        }
    }
    else{
        next();
    }
});

router.get('/resetPassword', async (req, res, next) => {
    if(req.query.activationToken){
        const user_verification = await prisma.user_email_verification.findUnique({
            'where': {
                'token': req.query.activationToken
            },
            'include': {
                'user': true
            }
        });
        if(user_verification && user_verification.reason == "activation"){
            user_verification.viewInBrowser = `https://${process.env.DOMAIN}/mail/resetPassword?activationToken=${user_verification.token}`;
            user_verification.password_reset_form_uri = `https://${process.env.FRONTEND_DOMAIN}/passwordReset/${user_verification.token}`;
            res.ejsRender('resetPassword.ejs', {...user_verification}, {'language': "de-de", 'template': "email"}).then(file => {
                res.send(file);
            }).catch(error => {
                pushLog(error, `Rendering activation mail for ${user_verification.user.username}`);
                res.status(500).send(error);
            });
        }
        else{
            next();
        }
    }
    else{
        next();
    }
});

module.exports = router;