const router = require('express').Router();
const {Api, ErrorResponse} = require('../../src/Api');
const {User, QueryBuilder} = require('../../src/Model/User');

router.all('*', async (req, res, next) => {
    if(req.session){
        req.User = new User({'user': req.user});
        next();
    }
    else{
        res.status(403).send({'status_code': res.statusCode, 'message': "No valid session"});
    }
});

// GET ALL USERS
router.get('/', async function(req, res) {
    let response, status_code = 200;
    try{
        if(req.user.role != 'admin'){
            throw new ErrorResponse("No permisson", 403);
        }
        const { q = {}, include = {}, limit = 25, offset = 0, sortBy = "id", sortOrder = "asc" } = req.query;

        const data = await req.User.getAll(q, include, limit, offset, sortBy, sortOrder);
        response = Api.getAllResponseBody(data, {'take': req.User.take(limit), 'skip': req.User.skip(offset)});
    }
    catch(error){
        const qb_error = QueryBuilder.errorHandler(error);
        status_code = error.status_code || qb_error.status_code;
        response = Api.errorResponseBody(status_code, error?.code, qb_error.message);
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
        const qb_error = QueryBuilder.errorHandler(error);
        status_code = error.status_code || qb_error.status_code;
        response = Api.errorResponseBody(status_code, error?.code, qb_error.message);
    }
    res.status(status_code).send(response);
});

// UPDATE USER BY ID
router.patch('/:id', async function(req, res) {
    let response, status_code = 200, payload = req.body;
    try{
        response = await req.User.update(req.params.id, payload);
    }
    catch(error){
        const qb_error = QueryBuilder.errorHandler(error, payload);
        status_code = error.status_code || qb_error.status_code;
        response = Api.errorResponseBody(status_code, error?.code, qb_error.message);
    }
    res.status(status_code).send(response);
});

// CREATE USER
router.post('/', async function(req, res) {
    let response, status_code = 201, payload = req.body;
    try{
        if(req.user.role != 'admin'){
            throw new ErrorResponse("No permisson", 403);
        }

        response = await req.User.create(payload);
    }
    catch(error){
        const qb_error = QueryBuilder.errorHandler(error, payload);
        status_code = error.status_code || qb_error.status_code;
        response = Api.errorResponseBody(status_code, error?.code, qb_error.message);
    }
    res.status(status_code).send(response);
});

// CREATE USER
router.post('changePassword/', async function(req, res) {
    let response, status_code = 200, payload = req.body;
    try{
        if(typeof payload?.email === 'string'){
            if(await req.User.sendPasswordResetEmail(payload.email)){
                response = {'status': status_code, 'message': "Password reset email sent"};
            }
        }
        else{
            throw new ErrorResponse(`Email in body is not type of 'string'. ${typeof payload.email} given.`, 400);
        }
    }
    catch(error){
        const qb_error = QueryBuilder.errorHandler(error, payload);
        status_code = error.status_code || qb_error.status_code;
        response = Api.errorResponseBody(status_code, error?.code, qb_error.message);
    }
    res.status(status_code).send(response);
});


router.delete('/:id', async (req, res)=>{
    let response, status_code = 200;
    try{
        if(req.user.role != 'admin'){
            throw new ErrorResponse("No permisson", 403);
        }
        await req.User.delete(req.params.id);
        response = {'status_code': status_code, 'message': "User successfully deleted"}
    }
    catch(error){
        const qb_error = QueryBuilder.errorHandler(error);
        status_code = error.status_code || qb_error.status_code;
        response = Api.errorResponseBody(status_code, error?.code, qb_error.message);
    }
    res.status(status_code).send(response);
});

module.exports = router;