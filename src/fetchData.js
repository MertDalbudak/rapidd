const {RestApi} = require('../lib/RestApi');

const limit = parseInt(process.env.API_RESULT_LIMIT, 10) || 500;
const maxParallel = 20;

async function fetchAllPaginatedData(serviceName, endpointName, options = {}) {
    let offset = 0;
    let keepFetching = true;
    let activeRequests = 0;

    const allResults = [];
    
    async function fetchWithRetry(currentOffset, attempts = 0) {
        const request_options = {
            'params': {
                ...(options['params'] || {})
            },
            'queries':{
                ...(options['queries'] || {}),
                'limit': limit,
                'offset': currentOffset
            },
            'headers': {
                ...(options['headers'] || {})
            }
        };
        const endpoint = await RestApi.create(serviceName, endpointName, request_options);
        try {
            const response = await endpoint.request();
            const records = response?.data?.items || response?.data || response?.items || [];

            if (records.length === 0) {
                keepFetching = false;
            }
            console.log(`[${serviceName}][${endpointName}] - offset: ${currentOffset} | current count: ${records.length}`);
            
            allResults.push(...records);
            return records;
        } catch (error) {
            console.error(error);
            if (attempts < 2) {
                console.warn(`[${serviceName}][${endpointName}] Retry ${attempts + 2} for offset ${currentOffset}`);
                return fetchWithRetry(currentOffset, attempts + 1);
            } else {
                throw new Error(`[${serviceName}][${endpointName}] Failed after 3 retries at offset ${currentOffset}: ${error.message}`);
            }
        }
    }

    async function launchRequest() {
        if (!keepFetching) return;

        const currentOffset = offset;
        offset += limit;
        activeRequests++;

        try {
            await fetchWithRetry(currentOffset);
        } finally {
            activeRequests--;
            if (keepFetching) {
                await launchRequest();
            }
        }
    }

    const tasks = Array.from({ length: maxParallel }, () => launchRequest());
    await Promise.all(tasks);

    console.log(`✅ [${serviceName}][${endpointName}] Fetched ${allResults.length} records`);
    return allResults;
}


module.exports = fetchAllPaginatedData;