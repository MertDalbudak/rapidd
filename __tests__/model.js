const User = require('../src/Model/User');
const user = new User();

describe('Get User', () => {
    it('should retrieve one user', async (done) => {
        const res = await User.get(1)
        expect(typeof res).toEqual("object");
        done();
    });
});