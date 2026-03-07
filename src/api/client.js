function sendLog(log) {
    const headers = {};
    const serializeData = serializeTelemetryBatch(log);
    if (!serializeData.success || !serializeData.data) {
        throw new Error(`serializeTelemetryBatch failed: ${serializeData.error || 'unknown error'}`);
    }
    const serializeLogBody = serializeData.data;
    headers["Content-Length"] = String(serializeLogBody.length);
    // ... rest of the implementation
}