const Users = require('../src/Model/Users');
describe('Get Login Fail Stack', () => {
    it('should retrieve all failed logins since last successful login', async (done) => {
        const res = await Users.getLoginFailStack(45);
        expect(Array.isArray(res)).toEqual(true);
        done();
    });
});

describe('Get User', () => {
    it('should retrieve one user', async (done) => {
        const res = await Users.get(45);
        expect(typeof res).toEqual("object");
        done();
    });
});