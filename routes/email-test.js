const router = require('express').Router();
const pushLog = require('../lib/pushLog');
const SendMail = require('../lib/SendMail')

router.get('/confirmation', function(req, res){
    res.ejsRender('confirmation.ejs', function(error, file){
        if(error != null){
            pushLog(error, "Logout");
            res.end();
        }
        else{
            new SendMail('default', 'mert.dalbudak@hotmail.com', "[TEST] for Confirmation", file, (status)=>{
                if(status)
                    res.newMessage('success', "Mail sent");
                else
                    res.newMessage('warn', "Mail couldn't be sent");
                res.send(file);
            })
        }
    }, 'email');
});

module.exports = router;