const router = require('express').Router();
const pushLog = require('../lib/pushLog');

router.get('/', function(req, res) {
    res.ejsRender('home.ejs', (err, file) => {
        if(err == null){
            res.clearCookie('msgs');
            res.send(file);
        }
        else{
            pushLog(err, "rendering home");
            res.sendStatus(500);
        }
        res.end();
    });
});

router.get('/logout', function(req, res){
    // TODO CREATE MESSAGE IN SESSION
    req.session.destroy((err)=>{
        if(err != null){
            pushLog(err, "Logout");
        }
        else
            res.newMessage('success', "signOut_message");
        res.redirect(302, '/');
    })
});

router.get('/signin', function(req, res) {
    // CHECK IF ALREADY SIGNED IN
    if(req.user != null){
        res.redirect(302, '/');
        return;
    }
    res.ejsRender('signin.ejs', (err, file) => {
        if(err == null){
            res.clearCookie('msgs');
            res.send(file);
        }
        else{
            console.error(err);
            pushLog(err, "signin");
            res.sendStatus(500);
        }
        res.end();
    });
});

router.get('/signup', function(req, res) {
    // CHECK IF ALREADY SIGNED IN
    if(req.user != null){
        res.redirect(302, '/');
        return;
    }
    res.ejsRender('signup.ejs', (err, file) => {
        if(err == null){
            res.clearCookie('msgs');
            res.send(file);
        }
        else{
            pushLog(err, "signup");
            res.sendStatus(500);
        }
        res.end();
    });
});


module.exports = router;