const router = require('express').Router();
const pushLog = require('../lib/pushLog');

router.get('/', function(req, res){
    res.end("Self Service")
});

module.exports = router;