export type QrValidationFlow = 'receive-vc-offer' | 'receive-vp-request' | 'send-vp-request';

export interface QrValidationSuccess {
  ok: true;
  flow: QrValidationFlow;
  kind: 'vc_offer' | 'vp_request';
  normalizedUrl: string;
  details: Record<string, unknown>;
}

export interface QrValidationFailure {
  ok: false;
  flow: QrValidationFlow;
  error: string;
  details?: Record<string, unknown>;
}

export type QrValidationResult = QrValidationSuccess | QrValidationFailure;

export function validateQrPayload(flow: QrValidationFlow, payload: string): QrValidationResult {
  const trimmed = payload.trim();
  if (!trimmed) return invalid(flow, 'payload must be a non-empty string');

  if (flow === 'receive-vc-offer') return validateCredentialOfferQr(flow, trimmed);
  return validatePresentationRequestQr(flow, trimmed);
}

function validateCredentialOfferQr(flow: QrValidationFlow, payload: string): QrValidationResult {
  const url = parseUrl(flow, payload);
  if (!url.ok) return url;

  if (url.value.protocol !== 'openid-credential-offer:') {
    return invalid(flow, 'VC offer QR must use openid-credential-offer://');
  }

  const offerUri = url.value.searchParams.get('credential_offer_uri')?.trim();
  const offerByValue = url.value.searchParams.get('credential_offer')?.trim();
  if (!offerUri && !offerByValue) {
    return invalid(flow, 'VC offer QR must include credential_offer_uri or credential_offer');
  }

  if (offerUri) {
    const offerTarget = parseAbsoluteHttpUrl(offerUri);
    if (!offerTarget.ok) return invalid(flow, 'credential_offer_uri must be an absolute http(s) URL', { credential_offer_uri: offerUri });
    return {
      ok: true,
      flow,
      kind: 'vc_offer',
      normalizedUrl: url.value.toString(),
      details: {
        credential_offer_uri: offerTarget.value.toString(),
      },
    };
  }

  let offer: unknown;
  try {
    offer = JSON.parse(offerByValue!);
  } catch {
    return invalid(flow, 'credential_offer must be valid JSON');
  }
  if (!isObject(offer)) return invalid(flow, 'credential_offer must decode to an object');

  const credentialIssuer = typeof offer.credential_issuer === 'string' ? offer.credential_issuer.trim() : '';
  const configIds = Array.isArray(offer.credential_configuration_ids) ? offer.credential_configuration_ids.filter((v) => typeof v === 'string' && v.length > 0) : [];
  if (!credentialIssuer) return invalid(flow, 'credential_offer.credential_issuer is required');
  if (configIds.length === 0) return invalid(flow, 'credential_offer.credential_configuration_ids must be a non-empty string array');

  return {
    ok: true,
    flow,
    kind: 'vc_offer',
    normalizedUrl: url.value.toString(),
    details: {
      credential_issuer: credentialIssuer,
      credential_configuration_ids: configIds,
    },
  };
}

function validatePresentationRequestQr(flow: QrValidationFlow, payload: string): QrValidationResult {
  const url = parseUrl(flow, payload);
  if (!url.ok) return url;

  if (!['openid4vp:', 'openid-vc:'].includes(url.value.protocol)) {
    return invalid(flow, 'VP QR must use openid4vp:// or openid-vc://');
  }
  if (!['', '/', '/authorize'].includes(url.value.pathname)) {
    return invalid(flow, 'VP QR path must be empty or /authorize', { pathname: url.value.pathname });
  }

  const clientId = url.value.searchParams.get('client_id')?.trim();
  if (!clientId) return invalid(flow, 'VP QR must include client_id');

  const responseType = url.value.searchParams.get('response_type')?.trim();
  if (responseType && !responseType.split(/\s+/).includes('vp_token')) {
    return invalid(flow, 'response_type must include vp_token', { response_type: responseType });
  }

  const requestUri = url.value.searchParams.get('request_uri')?.trim();
  const dcqlQueryRaw = url.value.searchParams.get('dcql_query')?.trim();
  const presentationDefinitionRaw = url.value.searchParams.get('presentation_definition')?.trim();
  if (!requestUri && !dcqlQueryRaw && !presentationDefinitionRaw) {
    return invalid(flow, 'VP QR must include request_uri, dcql_query, or presentation_definition');
  }

  const details: Record<string, unknown> = { client_id: clientId };

  if (requestUri) {
    const parsed = parseAbsoluteUrlOrUrn(requestUri);
    if (!parsed.ok) return invalid(flow, 'request_uri must be an absolute URL or URN', { request_uri: requestUri });
    details.request_uri = parsed.value.toString();
  }

  if (dcqlQueryRaw) {
    let dcqlQuery: unknown;
    try {
      dcqlQuery = JSON.parse(dcqlQueryRaw);
    } catch {
      return invalid(flow, 'dcql_query must be valid JSON');
    }
    if (!isValidDcqlQuery(dcqlQuery)) return invalid(flow, 'dcql_query must contain a non-empty credentials array');
    details.dcql_query = dcqlQuery;
  }

  if (presentationDefinitionRaw) {
    let presentationDefinition: unknown;
    try {
      presentationDefinition = JSON.parse(presentationDefinitionRaw);
    } catch {
      return invalid(flow, 'presentation_definition must be valid JSON');
    }
    if (!isValidPresentationDefinition(presentationDefinition)) {
      return invalid(flow, 'presentation_definition must include id and non-empty input_descriptors');
    }
    details.presentation_definition = presentationDefinition;
  }

  return {
    ok: true,
    flow,
    kind: 'vp_request',
    normalizedUrl: url.value.toString(),
    details,
  };
}

function parseUrl(flow: QrValidationFlow, payload: string):
QrValidationFailure | { ok: true; value: URL } {
  try {
    return { ok: true, value: new URL(payload) };
  } catch {
    return invalid(flow, 'payload must be a valid URL');
  }
}

function parseAbsoluteHttpUrl(value: string): { ok: true; value: URL } | { ok: false } {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return { ok: false };
    return { ok: true, value: url };
  } catch {
    return { ok: false };
  }
}

function parseAbsoluteUrlOrUrn(value: string): { ok: true; value: URL } | { ok: false } {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'urn:'].includes(url.protocol)) return { ok: false };
    return { ok: true, value: url };
  } catch {
    return { ok: false };
  }
}

function isValidDcqlQuery(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value.credentials) || value.credentials.length === 0) return false;
  return value.credentials.every((entry) =>
    isObject(entry) &&
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.format === 'string' &&
    entry.format.length > 0,
  );
}

function isValidPresentationDefinition(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (!Array.isArray(value.input_descriptors) || value.input_descriptors.length === 0) return false;
  return true;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

function invalid(flow: QrValidationFlow, error: string, details?: Record<string, unknown>): QrValidationFailure {
  return { ok: false, flow, error, ...(details ? { details } : {}) };
}
