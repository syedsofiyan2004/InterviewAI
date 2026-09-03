import { KekaHireIntegration, KekaIntegrationError } from '../lambdas/api-handler/intelligence-integrations';

const tokenResponse = () => new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

const interviewPage = {
  data: [{
    id: 'interview-1',
    scheduledAt: '2026-08-14T10:00:00Z',
    interviewers: [{ id: 'employee-1', name: 'Panel Member' }],
  }],
};

const priorKekaEnv = {
  secretArn: process.env.KEKA_SECRET_ARN,
  baseUrl: process.env.KEKA_BASE_URL,
  clientId: process.env.KEKA_CLIENT_ID,
  clientSecret: process.env.KEKA_CLIENT_SECRET,
  apiKey: process.env.KEKA_API_KEY,
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('Keka panel email resolution', () => {
  beforeAll(() => {
    delete process.env.KEKA_SECRET_ARN;
    process.env.KEKA_BASE_URL = 'https://tenant.keka.com';
    process.env.KEKA_CLIENT_ID = 'client-id';
    process.env.KEKA_CLIENT_SECRET = 'client-secret';
    process.env.KEKA_API_KEY = 'api-key';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    restoreEnv('KEKA_SECRET_ARN', priorKekaEnv.secretArn);
    restoreEnv('KEKA_BASE_URL', priorKekaEnv.baseUrl);
    restoreEnv('KEKA_CLIENT_ID', priorKekaEnv.clientId);
    restoreEnv('KEKA_CLIENT_SECRET', priorKekaEnv.clientSecret);
    restoreEnv('KEKA_API_KEY', priorKekaEnv.apiKey);
  });

  test('hydrates a Hire panel employee ID with the HRIS employee email', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) return jsonResponse(interviewPage);
      if (url.includes('/api/v1/hris/employees?')) {
        return jsonResponse({ data: [{ id: 'employee-1', email: 'panel.member@minfytech.com' }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const interviews = await new KekaHireIntegration().listInterviews('job-1', 'candidate-1');

    expect(interviews[0].panel[0].email).toBe('panel.member@minfytech.com');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/hris/employees?employeeIds=employee-1'),
      expect.any(Object),
    );
  });

  test('a denied HRIS lookup degrades instead of failing the whole sweep', async () => {
    // Originally this threw. That aborted listInterviews, which aborted the entire
    // schedule sweep — discarding every interview in the run, including any whose
    // panel email Keka Hire had already supplied and which needed no lookup at
    // all. The permission is optional to this call, so a denial must cost only the
    // addresses it could not resolve.
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) return jsonResponse(interviewPage);
      if (url.includes('/api/v1/hris/employees?')) return jsonResponse({}, 403);
      throw new Error(`Unexpected URL: ${url}`);
    });

    const integration = new KekaHireIntegration();
    const interviews = await integration.listInterviews('job-1', 'candidate-1');

    expect(interviews).toHaveLength(1);
    expect(interviews[0].panel[0].email).toBeUndefined();
    // The actionable message is not lost — it becomes a diagnostic the sweep
    // reports, so an empty My Interviews page names the permission to grant.
    expect(integration.panelEmailLookupError).toBe(
      'Keka denied access to employee email data. Ask a Keka administrator to grant HRIS Employees Read permission to the API application.',
    );
  });

  test('hydrates a name-only Hire panel member through HRIS employee search', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) {
        return jsonResponse({
          data: [{
            id: 'interview-name-only',
            scheduledAt: '2026-08-14T10:00:00Z',
            interviewers: [{ name: 'Rahul Bhatia' }],
          }],
        });
      }
      if (url.includes('/api/v1/hris/employees?searchKey=Rahul%20Bhatia')) {
        return jsonResponse({ data: [{ id: 'employee-rahul', displayName: 'Rahul Bhatia', email: 'rahul.bhatia@minfytech.com' }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const interviews = await new KekaHireIntegration().listInterviews('job-1', 'candidate-1');

    expect(interviews[0].panel[0].email).toBe('rahul.bhatia@minfytech.com');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/hris/employees?searchKey=Rahul%20Bhatia'),
      expect.any(Object),
    );
  });

  test('does not assign a name-search email when HRIS returns ambiguous exact matches', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) {
        return jsonResponse({
          data: [{
            id: 'interview-ambiguous-name',
            scheduledAt: '2026-08-14T10:00:00Z',
            interviewers: [{ name: 'Panel Member' }],
          }],
        });
      }
      if (url.includes('/api/v1/hris/employees?searchKey=Panel%20Member')) {
        return jsonResponse({
          data: [
            { id: 'employee-1', displayName: 'Panel Member', email: 'panel.one@minfytech.com' },
            { id: 'employee-2', displayName: 'Panel Member', email: 'panel.two@minfytech.com' },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const interviews = await new KekaHireIntegration().listInterviews('job-1', 'candidate-1');

    expect(interviews[0].panel[0].email).toBeUndefined();
  });

  test('an interview whose email Hire supplied survives a denial for the others', async () => {
    // The case the hard failure used to destroy: one round is fully indexable and
    // must not be lost because a different round needed the directory.
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) {
        return jsonResponse({
          data: [
            { ...interviewPage.data[0], id: 'has-email', interviewers: [{ id: 'employee-9', name: 'Direct', email: 'direct@minfytech.com' }] },
            interviewPage.data[0],
          ],
        });
      }
      if (url.includes('/api/v1/hris/employees?')) return jsonResponse({}, 403);
      throw new Error(`Unexpected URL: ${url}`);
    });

    const interviews = await new KekaHireIntegration().listInterviews('job-1', 'candidate-1');

    const withEmail = interviews.filter((interview) => interview.panel.some((member) => member.email));
    expect(withEmail).toHaveLength(1);
    expect(withEmail[0].panel[0].email).toBe('direct@minfytech.com');
  });

  test('one denial stops the lookup being re-requested for every later batch', async () => {
    // 200 unresolved ids would otherwise mean two more guaranteed-403 round trips
    // per call, for the whole run.
    let hrisCalls = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) {
        return jsonResponse({
          data: Array.from({ length: 250 }, (_, index) => ({
            ...interviewPage.data[0],
            id: `interview-${index}`,
            interviewers: [{ id: `employee-${index}`, name: `Panel ${index}` }],
          })),
        });
      }
      if (url.includes('/api/v1/hris/employees?')) {
        hrisCalls += 1;
        return jsonResponse({}, 403);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const integration = new KekaHireIntegration();
    await integration.listInterviews('job-1', 'candidate-1');
    await integration.listInterviews('job-1', 'candidate-1');

    expect(hrisCalls).toBe(1);
    expect(integration.panelEmailLookupError).toBeTruthy();
  });

  test('a transport failure still propagates — it is not evidence of a denial', async () => {
    // Only a Keka answer (403/404) means "you cannot have this". A dropped
    // connection means try again, and must not be recorded as a permission gap.
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) return jsonResponse(interviewPage);
      if (url.includes('/api/v1/hris/employees?')) throw new TypeError('fetch failed');
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(new KekaHireIntegration().listInterviews('job-1', 'candidate-1')).rejects.toThrow();
  });

  test('does not call HRIS when Hire already includes the panel email', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) {
        return jsonResponse({
          data: [{
            ...interviewPage.data[0],
            interviewers: [{ id: 'employee-1', name: 'Panel Member', email: 'direct@minfytech.com' }],
          }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const interviews = await new KekaHireIntegration().listInterviews('job-1', 'candidate-1');

    expect(interviews[0].panel[0].email).toBe('direct@minfytech.com');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/hris/employees'))).toBe(false);
  });

  test('uses a raw email address from a string-form Hire panel without HRIS lookup', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) {
        return jsonResponse({
          data: [{
            id: 'interview-email-string',
            scheduledAt: '2026-08-14T10:00:00Z',
            panel: 'syed.sofiyan@minfytech.com',
          }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const interviews = await new KekaHireIntegration().listInterviews('job-1', 'candidate-1');

    expect(interviews[0].panel[0].email).toBe('syed.sofiyan@minfytech.com');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/hris/employees'))).toBe(false);
  });

  test('uses an email embedded in a string-form Hire panel member', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) {
        return jsonResponse({
          data: [{
            id: 'interview-name-email-string',
            scheduledAt: '2026-08-14T10:00:00Z',
            panel: 'Syed Sofiyan <syed.sofiyan@minfytech.com>',
          }],
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const interviews = await new KekaHireIntegration().listInterviews('job-1', 'candidate-1');

    expect(interviews[0].panel[0].name).toBe('Syed Sofiyan');
    expect(interviews[0].panel[0].email).toBe('syed.sofiyan@minfytech.com');
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/v1/hris/employees'))).toBe(false);
  });

  test('batches duplicate panel IDs and caches them across interview-list calls', async () => {
    let hrisCalls = 0;
    const duplicatePanelPage = {
      data: [
        interviewPage.data[0],
        { ...interviewPage.data[0], id: 'interview-2' },
      ],
    };
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/connect/token')) return tokenResponse();
      if (url.includes('/candidate/candidate-1/interviews')) return jsonResponse(duplicatePanelPage);
      if (url.includes('/api/v1/hris/employees?')) {
        hrisCalls += 1;
        return jsonResponse({ data: [{ id: 'employee-1', email: 'panel.member@minfytech.com' }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const integration = new KekaHireIntegration();
    const first = await integration.listInterviews('job-1', 'candidate-1');
    const second = await integration.listInterviews('job-1', 'candidate-1');

    expect(first.every((interview) => interview.panel[0].email === 'panel.member@minfytech.com')).toBe(true);
    expect(second.every((interview) => interview.panel[0].email === 'panel.member@minfytech.com')).toBe(true);
    expect(hrisCalls).toBe(1);
  });
});
