const router = require('express').Router();
const RestApi = require('../lib/RestApi');
const pushLog = require('../lib/pushLog');

router.get('/', async (req, res) => {
    const opp_request = new RestApi('EC', 'allOpportunities');   
    let opp;
    try{
        console.time('Start request');
        opp = await opp_request.req();
        console.timeEnd('Start request');
    }catch(error){
        pushLog(error, "Retrieve Opportunities", 'request');
        res.newMessage('error', 'error_message1');
        res.redirect('/');
        return;
    }
    res.ejsRender('opportunities.ejs', {'opportunities': opp.items}, (err, file)=>{
        if(err == null){
            res.clearCookie('msgs');
            res.send(file);
        }
        else {
            pushLog(err);
            res.send(err);
        }
        res.end();
    });
});

router.get('/:id', async (req, res) => {
    const opp_request = new RestApi('EC', 'getOpportunity', {'params': {'id': req.params.id}});   
    let opp;
    try{
        console.time('Start request');
        opp = await opp_request.req();
        console.timeEnd('Start request');
    }catch(error){
        pushLog(error, "Retrieve Opportunities", 'request');
        res.newMessage('error', 'error_message1');
        res.redirect('/');
        return;
    }
    res.ejsRender('opportunity.ejs', {'opportunity': opp}, (err, file)=>{
        if(err == null){
            res.clearCookie('msgs');
            res.send(file);
        }
        else {
            pushLog(err);
            res.send(err);
        }
        res.end();
    });
});

module.exports = router;