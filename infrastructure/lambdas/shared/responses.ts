import { ErrorResponseSchema, ErrorCode } from '../../schema';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE',
  // Progress timestamps (analysis_started_at, composite_started_at, progress
  // events) are stamped from the Lambda clock, but a browser renders them
  // against its own. Those are not the same clock: a workstation a minute behind
  // made `Date.now() - analysis_started_at` negative and pinned every elapsed
  // timer to 0:00. Publishing the server clock on every response lets the client
  // measure its own skew once and read server time thereafter, so no elapsed
  // value is ever derived from two disagreeing clocks. Must be exposed
  // explicitly — CORS hides all but a handful of response headers from JS.
  'Access-Control-Expose-Headers': 'X-Server-Time',
};

export function apiResponse(statusCode: number, body: any) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, 'X-Server-Time': String(Date.now()) },
    body: JSON.stringify(body),
  };
}

export function errorResponse(statusCode: number, code: string, message: string, details?: any) {
  return apiResponse(statusCode, {
    error: {
      code,
      message,
      details,
    },
  });
}

export function successResponse(body: any) {
  return apiResponse(200, body);
}

export function createdResponse(body: any) {
  return apiResponse(201, body);
}

export function acceptedResponse(body: any) {
  return apiResponse(202, body);
}

