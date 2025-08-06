const router = require('express').Router();
const bcrypt = require('bcrypt');
const {Api, ErrorResponse} = require('../../../src/Api');
const {User, QueryBuilder, prisma} = require('../../../src/Model/User');

router.all('*', async (req, res, next) => {
    if(req.user){
        req.User = new User({'user': req.user});
        next();
    }
    else{
        res.status(401).send({'status_code': res.statusCode, 'message': "No valid session"});
    }
});

// GET ALL USERS
router.get('/', async function(req, res) {
    let response, status_code = 200;
    try {
        Api.checkPermission(req.user, ['super_admin', 'admin']);
        const { q = {}, include = "", limit = 25, offset = 0, sortBy = "id", sortOrder = "asc" } = req.query;

        const _data = req.User.getMany(q, include, limit, offset, sortBy, sortOrder);
        const _count = req.User.count(q);
        const [data, count] = await Promise.all([_data, _count]);

        response = Api.getListResponseBody(data, {'take': req.User.take(Number(limit)), 'skip': req.User.skip(Number(offset)), 'total': count});
    }
    catch(error){
        response = QueryBuilder.errorHandler(error);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

// GET USER BY ID
router.get('/:id', async function(req, res) {
    let response, status_code = 200;
    try{
        const { include = {}} = req.query;
        
        response = await req.User.get(parseInt(req.params.id), include);
    }
    catch(error){
        response = QueryBuilder.errorHandler(error);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

// CREATE USER
router.post('/', async function(req, res) {
    let response, status_code = 201, payload = req.body;
    try{
        Api.checkPermission(req.user, ['super_admin', 'admin']);
        if(req.user.role == "admin" && ['admin', 'super_admin'].includes(payload.role)){
            throw new ErrorResponse("You are not allowed to create an admin", 403);
        }

        response = await req.User.create(payload);
    }
    catch(error){
        response = QueryBuilder.errorHandler(error, payload);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

// CHANGE PASSWORD
router.patch('/changePassword', async function(req, res) {
    let response, status_code = 200, payload = req.body;
    try{
        const expected =  ['current_password', 'new_password', 'repeat_password'];
        for(let key in payload){
            const index = expected.findIndex(e => e == key);
            if(index > -1){
                if(typeof payload[key] != "string"){
                    throw new ErrorResponse(`${key} was expected to be type of string. ${typeof key} was given.`, 400);
                }
                expected.splice(index, 1);
            }
            else{
                throw new ErrorResponse(`Given key '${key}' is not expected`, 400);
            }
        }
        if(expected.length == 0){
            const user = await prisma.user.findUnique({
                'where': {
                    'id': req.user.id
                },
                'select': {
                    'hash': true
                }
            });
            if(await bcrypt.compare(payload.current_password, user.hash)){
                if(payload.new_password == payload.repeat_password){
                    if(await req.User.changePassword(req.user.id, payload.new_password)){
                        response = {
                            'status': "success",
                            'message': "Password has been changed"
                        }
                    }
                    else{
                        throw new ErrorResponse("The password couldn't be changed. Try again later.", 500);
                    }
                }
                else{
                    throw new ErrorResponse("The repeated password does not match the new password", 400);
                }
            }
            else{
                throw new ErrorResponse("Current password was entered incorrectly", 400);
            }
        }
        else{
            throw new ErrorResponse(`${expected.join(', ')} are not defined`, 400);
        }
    }
    catch(error){
        response = QueryBuilder.errorHandler(error, payload);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

// UPDATE USER BY ID
router.patch('/:id', async function(req, res) {
    let response, status_code = 200, payload = req.body;
    try{
        Api.checkPermission(req.user, ['super_admin', 'admin']);
        response = await req.User.update(req.params.id, payload);
    }
    catch(error){
        response = QueryBuilder.errorHandler(error, payload);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

router.delete('/:id', async (req, res)=>{
    let response, status_code = 200;
    try{
        Api.checkPermission(req.user, ['super_admin']);
        await req.User.delete(req.params.id);
        response = {'status_code': status_code, 'message': "User successfully deleted"}
    }
    catch(error){
        response = QueryBuilder.errorHandler(error);
        status_code = response.status_code;
    }
    res.status(status_code).send(response);
});

module.exports = router;