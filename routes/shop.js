const router = require('express').Router();
const pushLog = require('../lib/pushLog');

router.get('/', function(req, res){
    res.end("Loyality Shop");
});

module.exports = router;