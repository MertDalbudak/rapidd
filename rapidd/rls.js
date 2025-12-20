const { requestContext } = require('../rapidd/rapidd');

function setRLSContext(req, res, next) {
    // CHANGE TO YOUR CONTEXT VARIABLES
    const userId = req.user?.id;
    const userRole = req.user?.role;

    if (userId && userRole) {
        // Run Request with Context
        requestContext.run({ userId, userRole }, () => {
            next();
        });
    } else {
        next();
    }
}

module.exports = { setRLSContext };