import { Readable } from 'node:stream';
import { Upload } from '@aws-sdk/lib-storage';
import { saveFileContent, s3Client } from '../lambdas/shared/aws';

jest.mock('@aws-sdk/lib-storage', () => ({ Upload: jest.fn() }));

describe('S3 streaming uploads', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('uses multipart upload for a recording stream', async () => {
    const done = jest.fn().mockResolvedValue({});
    const upload = Upload as unknown as jest.Mock;
    upload.mockImplementation((options) => ({ done, options }));
    const send = jest.spyOn(s3Client, 'send');
    const stream = Readable.from([Buffer.from([1, 2, 3, 4])]);

    await saveFileContent('recordings-bucket', 'recording.mp4', stream, 'video/mp4', 4);

    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      client: s3Client,
      params: expect.objectContaining({
        Bucket: 'recordings-bucket',
        Key: 'recording.mp4',
        Body: stream,
        ContentType: 'video/mp4',
        ContentLength: 4,
      }),
    }));
    expect(done).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
