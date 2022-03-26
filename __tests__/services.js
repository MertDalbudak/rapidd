const RestApi = require('../lib/RestApi');

describe('Testing OAut2', () => {
    it('sould retrieve all users from idcs', async (done) => {
        const allUsers = new RestApi('IDCS', 'allUsers');
        const res = await allUsers.req(null, true);
        console.log(res);
        expect(typeof res).toEqual('object');
        done();
    }, 15000);
});

describe('Testing EC service connections', () => {
    const ID = 44002;
    it('should retrieve contact by id: ' + ID, async (done) => {
        const getContact = new RestApi('EC', 'getContact', {'params': {'id': ID}});
        const res = await getContact.req();
        expect(parseInt(res['PartyNumber'])).toEqual(ID);
        done();
    }, 12000);

    const EMAIL = "just-a-test@invalid.com";
    it('should retrieve contact by email: ' + EMAIL, async (done) => {
        const getContact = new RestApi('EC', 'allContacts', {'queries': {'q': "EmailAddress=" + EMAIL}});
        const res = await getContact.req();
        console.log(res);
        expect(res.items[0]['EmailAddress']).toEqual(EMAIL);
        done();
    }, 12000);

    it('should retrieve all Accounts:', async (done) => {
        const allAccounts = new RestApi('EC', 'allAccounts');
        const res = await allAccounts.req();
        console.log(res);
        expect(typeof res).toEqual("object");
        done();
    }, 12000);

    it('should retrieve one opportunity', async (done) => {
        const getOpp = new RestApi('EC', 'getOpportunity', {'params': {'id': 14004}});
        console.time('Start request');
        const res = await getOpp.req();
        console.timeEnd('Start request');
        console.log(res);
        expect(typeof res).toEqual('object');
        done();
    }, 12000);

    it('should retrieve all opportunities', async (done) => {
        const getOpp = new RestApi('EC', 'allOpportunities');
        const res = await getOpp.req();
        //console.log(res);
        expect(typeof res).toEqual('object');
        done();
    }, 12000);

});