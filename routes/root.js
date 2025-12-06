const router = require('express').Router();
const pushLog = require('../lib/pushLog');

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

module.exports = router;