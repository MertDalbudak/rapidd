const router = require('express').Router();
const pushLog = require('../lib/pushLog');

router.get('/', function(req, res){
    res.end("LMC");
});

router.get('/form', function(req, res){
    //
});

module.exports = router;