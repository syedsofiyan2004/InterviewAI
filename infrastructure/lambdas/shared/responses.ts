import { ErrorResponseSchema, ErrorCode } from '../../schema';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'OPTIONS,GET,POST,PUT,DELETE',
};

export function apiResponse(statusCode: number, body: any) {
  return {
    statusCode,
    headers: CORS_HEADERS,
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

