const RestApi = require('../lib/RestApi');
const pushLog = require('../lib/pushLog')

it('should retrieve one opportunity', async (done) => {
    for(let i = 0; i < 20; i++){
        const getOpp = new RestApi('EC', 'getOpportunity', {'params': {'id': 14004}});
        const start = Date.now();
        const res = getOpp.req();
        res.then((data)=>{
            pushLog(`Response time: ${(Date.now() - start) / 1000}`, "Get One Opportunity", "debug");
        }, (err)=>{
            pushLog("Failed to retrieve data", "Get One Opportunity", "debug");
        })
        
        //console.log(res);
    }
    //setTimeout(done, 2000)
}, 40000);