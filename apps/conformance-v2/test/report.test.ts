import { describe, it, expect } from 'vitest';
import { toReportJson, toJunitXml, toReportHtml } from '../src/report/writer.js';
import type { Report } from '../src/runner.js';

function sampleReport(over: Partial<Report> = {}): Report {
  return {
    runId: 'r-test',
    startedAt: '2026-06-10T00:00:00.000Z',
    finishedAt: '2026-06-10T00:00:01.000Z',
    durationMs: 1000,
    target: { targetIssuer: 'http://127.0.0.1:1/mock' },
    results: [
      {
        id: 'A',
        name: 'Test A',
        operation: 'auth',
        passed: true,
        skipped: false,
        message: 'ok',
        responseStatus: 200,
        durationMs: 50,
      },
      {
        id: 'B',
        name: 'Test B',
        operation: 'auth',
        passed: false,
        skipped: false,
        message: 'mismatch',
        responseStatus: 500,
        responseBody: { error: 'boom' },
        durationMs: 80,
      },
    ],
    summary: { total: 2, passed: 1, failed: 1, skipped: 0 },
    aborted: true,
    abortedAt: 'B',
    ...over,
  };
}

describe('toReportJson', () => {
  it('returns valid JSON with the full report object', () => {
    const r = sampleReport();
    const parsed = JSON.parse(toReportJson(r));
    expect(parsed.runId).toBe('r-test');
    expect(parsed.results).toHaveLength(2);
    expect(parsed.abortedAt).toBe('B');
  });
});

describe('toJunitXml', () => {
  it('emits a JUnit <testsuite> with one <testcase> per result', () => {
    const xml = toJunitXml(sampleReport());
    expect(xml).toMatch(/^<\?xml version="1\.0"/);
    expect(xml).toContain('<testsuite');
    expect(xml).toContain('<testcase classname="conformance-v2.auth" name="A Test A"');
    expect(xml).toContain('<testcase classname="conformance-v2.auth" name="B Test B"');
  });

  it('marks failed cases with a <failure> element containing the body', () => {
    const xml = toJunitXml(sampleReport());
    expect(xml).toContain('<failure');
    expect(xml).toContain('mismatch');
    expect(xml).toContain('Response status: 500');
    // The JSON body is XML-escaped; the quote characters become &quot;.
    expect(xml).toContain('&quot;error&quot;: &quot;boom&quot;');
  });

  it('marks skipped cases with a <skipped/> element', () => {
    const xml = toJunitXml(
      sampleReport({
        results: [
          {
            id: 'S',
            name: 'Skipped',
            operation: 'auth',
            passed: false,
            skipped: true,
            message: 'SKIPPED no fixture',
            durationMs: 1,
          },
        ],
        summary: { total: 1, passed: 0, failed: 0, skipped: 1 },
        aborted: false,
        abortedAt: null,
      })
    );
    expect(xml).toContain('<skipped');
  });

  it('records the abort point as an <error> element', () => {
    const xml = toJunitXml(sampleReport());
    expect(xml).toMatch(/<error message="run aborted at B"/);
  });
});

describe('toReportHtml', () => {
  it('emits a self-contained HTML document with KPIs and per-case rows', () => {
    const html = toReportHtml(sampleReport());
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('Conformance v2 Report');
    expect(html).toContain('Run halted at:');
    expect(html).toContain('class="badge pass"');
    expect(html).toContain('class="badge fail"');
    expect(html).toContain('<tr class="pass">');
    expect(html).toContain('<tr class="fail">');
  });

  it('escapes special characters in test names to keep the HTML well-formed', () => {
    const r = sampleReport({
      results: [
        {
          id: 'X',
          name: '<script>alert(1)</script> & "quotes"',
          operation: 'auth',
          passed: true,
          skipped: false,
          durationMs: 1,
        },
      ],
    });
    const html = toReportHtml(r);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('omits the abort banner when the run completed cleanly', () => {
    const r = sampleReport({ aborted: false, abortedAt: null });
    const html = toReportHtml(r);
    expect(html).not.toContain('Run halted at:');
  });
});
