/**
 * BlueCat Edge Daily Security Report
 *
 * Akış:
 *   BlueCat API -> günlük JSON/CSV arşivi -> geçmiş tablosu -> yönetici PDF'i
 *   -> e-posta -> hata olursa yalnızca ALERT_TO adresine teknik bildirim.
 *
 * Zorunlu Script Properties:
 *   BLUECAT_BASE_URL
 *   BLUECAT_CLIENT_ID
 *   BLUECAT_CLIENT_SECRET
 *   ALERT_TO
 *   TEST_MODE                 TRUE veya FALSE
 *
 * Production için ayrıca:
 *   REPORT_TO
 *   REPORT_CC                Virgülle ayrılmış adresler
 *   REPORT_CUSTOMER_NAME
 */

const BLUECAT_REPORTING = Object.freeze({
  TIME_ZONE: 'Europe/Istanbul',
  ROOT_FOLDER_NAME: 'BlueCat Security Reports',
  HISTORY_FILE_NAME: 'BlueCat Security History',
  DAILY_HANDLER: 'runBlueCatDailyReport',
  TOKEN_PATH: '/v1/api/authentication/token',
  SITES_PATH: '/v3/api/sites',
  REPORT_PATH: '/v1/shepherd/reports/mostCompromisedEndpoints',
  MAX_PRIORITY_ROWS: 8,
  RETRY_DELAYS_MS: [1000, 3000, 7000]
});

const REPORT_COLORS = Object.freeze({
  background: '#0B1220',
  panel: '#162235',
  panelLight: '#1E2D43',
  text: '#F7FAFC',
  muted: '#9FB0C5',
  accent: '#35A7FF',
  critical: '#F04455',
  high: '#FF8A34',
  medium: '#F4C430',
  low: '#E7E6D5',
  success: '#34C38F',
  grid: '#314158'
});

const DAILY_SUMMARY_HEADERS = [
  'ReportKey', 'PeriodStartUTC', 'PeriodEndUTC', 'TotalSourceIPs',
  'CompromisedIPs', 'CompromisedRate', 'Critical', 'High', 'Medium', 'Low',
  'DGA', 'Tunneling', 'Typosquat', 'Rebinding', 'BlueCatThreatProtect',
  'NewIPs', 'RecurringIPs', 'ForwarderIPs', 'ConfirmedMalicious',
  'ConfirmedBenign', 'Unverified', 'GeneratedAtUTC'
];

const FINDING_HEADERS = [
  'ReportKey', 'SourceIP', 'VendorScore', 'VendorSeverity', 'AssetRole',
  'Site', 'Contributors', 'Indicators', 'Domains', 'OperationalStatus',
  'ReviewStatus'
];

const DOMAIN_REVIEW_HEADERS = [
  'Domain', 'Verdict', 'Owner', 'Evidence', 'ReviewDate', 'ExpiryDate', 'Notes'
];

/**
 * Önce bunu bir kez çalıştırın. Drive klasörünü ve geçmiş dosyasını oluşturur.
 * E-posta göndermez ve günlük tetikleyici kurmaz.
 */
function setupBlueCatWorkspace() {
  const workspace = ensureWorkspace_();
  console.log(JSON.stringify({
    status: 'WORKSPACE_READY',
    rootFolderName: workspace.rootFolder.getName(),
    rootFolderUrl: workspace.rootFolder.getUrl(),
    historyFileUrl: workspace.spreadsheet.getUrl()
  }, null, 2));
}

/**
 * BlueCat bağlantısını güvenli özetle doğrular. Token veya secret loglanmaz.
 */
function testBlueCatConnection() {
  const config = getConfig_();
  validateBlueCatConfig_(config);
  const blueCatData = fetchBlueCatData_(config);
  const report = blueCatData.report;

  const summary = {
    status: 'SUCCESS',
    tokenExpiresInSeconds: blueCatData.tokenExpiresInSeconds,
    siteCount: blueCatData.sites.length,
    reportFrom: new Date(report.dateFrom).toISOString(),
    reportTo: new Date(report.dateTo).toISOString(),
    totalSourceIps: report.ipCountTotal,
    compromisedIpCount: Array.isArray(report.ips) ? report.ips.length : 0
  };

  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

/**
 * Manuel testte de günlük tetikleyicide de çalışan ana fonksiyondur.
 */
function runBlueCatDailyReport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.log('Başka bir BlueCat rapor çalışması devam ettiği için bu çalışma atlandı.');
    return;
  }

  try {
    const result = generateAndSendDailyReport_();
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    sendErrorAlert_(error);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

/**
 * TEST_MODE=FALSE yapıldıktan ve production alıcıları girildikten sonra bir kez
 * çalıştırılır. Raporu her gün yaklaşık 10:00'da çalıştırır (+/- 15 dakika).
 */
function installDailyTrigger() {
  const config = getConfig_();
  validateMailConfig_(config);

  if (config.testMode) {
    throw new Error(
      'Güvenlik kontrolü: günlük tetikleyiciyi kurmadan önce TEST_MODE değerini FALSE yapın.'
    );
  }

  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === BLUECAT_REPORTING.DAILY_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger(BLUECAT_REPORTING.DAILY_HANDLER)
    .timeBased()
    .atHour(10)
    .nearMinute(0)
    .everyDays(1)
    .inTimezone(BLUECAT_REPORTING.TIME_ZONE)
    .create();

  console.log('Günlük tetikleyici kuruldu: her gün yaklaşık 10:00 Europe/Istanbul.');
}

/**
 * Backward-compatible production trigger name used in earlier deployments.
 */
function createProductionDailyTrigger() {
  return installDailyTrigger();
}

function removeDailyTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === BLUECAT_REPORTING.DAILY_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  console.log('Kaldırılan günlük tetikleyici sayısı: ' + removed);
}

function generateAndSendDailyReport_() {
  const config = getConfig_();
  validateBlueCatConfig_(config);
  validateMailConfig_(config);

  const blueCatData = fetchBlueCatData_(config);
  const report = blueCatData.report;
  validateSecurityReport_(report);

  const reportFrom = new Date(report.dateFrom);
  const reportTo = new Date(report.dateTo);
  const reportKey = Utilities.formatDate(
    reportFrom,
    BLUECAT_REPORTING.TIME_ZONE,
    'yyyy-MM-dd'
  );

  const workspace = ensureWorkspace_();
  const forwarderIps = extractForwarderIps_(blueCatData.sites);
  const priorIps = getPriorIpSet_(workspace.findingsSheet, reportKey);
  const siteNames = buildSiteNameMap_(blueCatData.sites);
  const domainReviewMap = syncDomainReview_(workspace.domainReviewSheet, report);
  const findings = buildFindings_(
    report,
    reportKey,
    siteNames,
    forwarderIps,
    priorIps,
    domainReviewMap
  );
  const previousSummary = getPreviousSummary_(workspace.summarySheet, reportKey);
  const metrics = calculateMetrics_(
    report,
    findings,
    reportKey,
    reportFrom,
    reportTo,
    previousSummary
  );

  upsertDailySummary_(workspace.summarySheet, metrics);
  replaceDailyFindings_(workspace.findingsSheet, reportKey, findings);
  SpreadsheetApp.flush();

  const recentSummaries = getRecentSummaries_(workspace.summarySheet, 7);
  const archiveFolder = getArchiveFolder_(workspace.rootFolder, reportKey);
  const baseName = 'BlueCat-Security-' + reportKey;

  const jsonFile = saveOrUpdateTextFile_(
    archiveFolder,
    baseName + '.json',
    JSON.stringify(report, null, 2),
    MimeType.PLAIN_TEXT
  );

  const csvFile = saveOrUpdateTextFile_(
    archiveFolder,
    baseName + '.csv',
    findingsToCsv_(findings),
    MimeType.CSV
  );

  const pdfBlob = createManagementPdf_(
    config,
    metrics,
    findings,
    recentSummaries,
    baseName + '.pdf'
  );
  const pdfFile = saveOrReplaceBlob_(archiveFolder, pdfBlob);

  const alreadySent = PropertiesService.getScriptProperties()
    .getProperty('LAST_SENT_REPORT_KEY') === reportKey;

  if (config.testMode || !alreadySent) {
    sendReportEmail_(config, metrics, findings, pdfFile);
    if (!config.testMode) {
      PropertiesService.getScriptProperties()
        .setProperty('LAST_SENT_REPORT_KEY', reportKey);
    }
  } else {
    console.log('Bu rapor production alıcılarına daha önce gönderilmiş: ' + reportKey);
  }

  return {
    status: 'SUCCESS',
    mode: config.testMode ? 'TEST' : 'PRODUCTION',
    reportKey: reportKey,
    totalSourceIps: metrics.totalSourceIps,
    compromisedIpCount: metrics.compromisedCount,
    critical: metrics.severityCounts.Critical,
    high: metrics.severityCounts.High,
    confirmedThreats: metrics.confirmedMaliciousCount,
    confirmedBenign: metrics.confirmedBenignCount,
    pendingReview: metrics.unverifiedCount,
    forwarderFindings: metrics.forwarderCount,
    jsonFile: jsonFile.getName(),
    csvFile: csvFile.getName(),
    pdfFile: pdfFile.getName(),
    archiveFolderUrl: archiveFolder.getUrl(),
    emailSent: config.testMode || !alreadySent
  };
}

function getConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const baseUrl = String(properties.getProperty('BLUECAT_BASE_URL') || '')
    .trim()
    .replace(/\/$/, '');

  return {
    baseUrl: baseUrl,
    clientId: String(properties.getProperty('BLUECAT_CLIENT_ID') || '').trim(),
    clientSecret: String(properties.getProperty('BLUECAT_CLIENT_SECRET') || '').trim(),
    alertTo: String(properties.getProperty('ALERT_TO') || '').trim(),
    reportTo: String(properties.getProperty('REPORT_TO') || '').trim(),
    reportCc: String(properties.getProperty('REPORT_CC') || '').trim(),
    customerName: String(
      properties.getProperty('REPORT_CUSTOMER_NAME') || 'Customer'
    ).trim(),
    testMode: String(properties.getProperty('TEST_MODE') || 'TRUE')
      .trim()
      .toUpperCase() !== 'FALSE'
  };
}

function validateBlueCatConfig_(config) {
  if (!config.baseUrl || !config.clientId || !config.clientSecret) {
    throw new Error(
      'BLUECAT_BASE_URL, BLUECAT_CLIENT_ID ve BLUECAT_CLIENT_SECRET Script Properties alanlarında zorunludur.'
    );
  }
}

function validateMailConfig_(config) {
  if (!config.alertTo) {
    throw new Error('ALERT_TO Script Property alanına kendi e-posta adresinizi girin.');
  }

  if (!config.testMode && !config.reportTo) {
    throw new Error('Production modunda REPORT_TO zorunludur.');
  }
}

function fetchBlueCatData_(config) {
  const tokenResult = fetchJsonWithRetry_(
    config.baseUrl + BLUECAT_REPORTING.TOKEN_PATH,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        grantType: 'ClientCredentials',
        clientCredentials: {
          clientId: config.clientId,
          clientSecret: config.clientSecret
        }
      })
    },
    'BlueCat token isteği'
  );

  if (!tokenResult.data.accessToken) {
    throw new Error('BlueCat token yanıtında accessToken bulunamadı.');
  }

  const authorizedRequest = {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + tokenResult.data.accessToken,
      Accept: 'application/json'
    }
  };

  const sitesResult = fetchJsonWithRetry_(
    config.baseUrl + BLUECAT_REPORTING.SITES_PATH,
    authorizedRequest,
    'BlueCat Sites API isteği'
  );

  const reportResult = fetchJsonWithRetry_(
    config.baseUrl + BLUECAT_REPORTING.REPORT_PATH,
    authorizedRequest,
    'BlueCat Security raporu isteği'
  );

  return {
    tokenExpiresInSeconds: tokenResult.data.expiresIn || null,
    sites: normalizeCollection_(sitesResult.data),
    report: reportResult.data
  };
}

function fetchJsonWithRetry_(url, requestOptions, requestName) {
  const options = Object.assign({}, requestOptions, {muteHttpExceptions: true});
  const delays = BLUECAT_REPORTING.RETRY_DELAYS_MS;
  let lastError;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const statusCode = response.getResponseCode();
      const responseText = response.getContentText();

      if (statusCode >= 200 && statusCode < 300) {
        try {
          return {data: JSON.parse(responseText), statusCode: statusCode};
        } catch (parseError) {
          throw new Error(requestName + ' geçerli JSON döndürmedi: ' + parseError.message);
        }
      }

      const safeBody = truncate_(responseText, 800);
      lastError = new Error(
        requestName + ' başarısız. HTTP ' + statusCode + ': ' + safeBody
      );

      if (statusCode < 500 && statusCode !== 429) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < delays.length) {
      Utilities.sleep(delays[attempt]);
    }
  }

  throw lastError || new Error(requestName + ' bilinmeyen bir hatayla başarısız oldu.');
}

function validateSecurityReport_(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('BlueCat Security raporu boş veya geçersiz.');
  }
  if (typeof report.dateFrom === 'undefined' || typeof report.dateTo === 'undefined') {
    throw new Error('Security raporunda dateFrom/dateTo bulunamadı.');
  }
  if (!Array.isArray(report.ips)) {
    report.ips = [];
  }
}

function normalizeCollection_(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  if (value && Array.isArray(value.items)) return value.items;
  return [];
}

function buildSiteNameMap_(sites) {
  const map = {};
  sites.forEach(function(site) {
    if (site && site.id) map[site.id] = site.name || site.id;
  });
  return map;
}

function extractForwarderIps_(sites) {
  const forwarders = new Set();
  sites.forEach(function(site) {
    const settings = site && site.settings ? site.settings : {};
    const namespaces = Array.isArray(settings.associatedNamespaces)
      ? settings.associatedNamespaces
      : [];
    namespaces.forEach(function(namespace) {
      const ips = Array.isArray(namespace.forwarders) ? namespace.forwarders : [];
      ips.forEach(function(ip) {
        if (ip) forwarders.add(String(ip).trim());
      });
    });
  });
  return forwarders;
}

function buildFindings_(
  report,
  reportKey,
  siteNames,
  forwarderIps,
  priorIps,
  domainReviewMap
) {
  return report.ips.map(function(item) {
    const ip = String(item.ip || '').trim();
    const score = Number(item.score || 0);
    const isForwarder = forwarderIps.has(ip);
    const isRecurring = priorIps.has(ip);
    const domains = normalizeStringArray_(item.domains).map(cleanDomain_);

    return {
      reportKey: reportKey,
      ip: ip,
      score: score,
      severity: severityFromScore_(score),
      assetRole: isForwarder ? 'DNS Forwarder' : 'Source IP',
      site: siteNames[item.siteId] || item.siteId || 'Unknown',
      contributors: normalizeStringArray_(item.contributors),
      indicators: normalizeStringArray_(item.indicators),
      domains: domains,
      operationalStatus: isRecurring ? 'Recurring' : 'New',
      reviewStatus: getFindingReviewStatus_(domains, domainReviewMap)
    };
  }).sort(function(a, b) {
    return b.score - a.score;
  });
}

function syncDomainReview_(sheet, report) {
  const reviewMap = {};
  const knownDomains = new Set();

  if (sheet.getLastRow() > 1) {
    const existingRows = sheet.getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      DOMAIN_REVIEW_HEADERS.length
    ).getValues();

    existingRows.forEach(function(row) {
      const domain = cleanDomain_(row[0]).toLowerCase();
      if (!domain) return;
      const verdict = activeReviewVerdict_(row[1], row[5]);
      knownDomains.add(domain);
      reviewMap[domain] = verdict;
    });
  }

  const reportDomains = new Set();
  report.ips.forEach(function(item) {
    normalizeStringArray_(item.domains).forEach(function(domain) {
      const normalizedDomain = cleanDomain_(domain).toLowerCase();
      if (normalizedDomain) reportDomains.add(normalizedDomain);
    });
  });

  const newRows = [];
  reportDomains.forEach(function(domain) {
    if (!knownDomains.has(domain)) {
      newRows.push([domain, 'UNVERIFIED', '', '', '', '', '']);
      reviewMap[domain] = 'UNVERIFIED';
    }
  });

  if (newRows.length) {
    sheet.getRange(
      sheet.getLastRow() + 1,
      1,
      newRows.length,
      DOMAIN_REVIEW_HEADERS.length
    ).setValues(newRows);
  }

  configureDomainReviewSheet_(sheet);
  return reviewMap;
}

function configureDomainReviewSheet_(sheet) {
  const validation = SpreadsheetApp.newDataValidation()
    .requireValueInList(
      ['UNVERIFIED', 'CONFIRMED_BENIGN', 'CONFIRMED_MALICIOUS'],
      true
    )
    .setAllowInvalid(false)
    .build();
  const dataRows = Math.max(1, sheet.getMaxRows() - 1);
  sheet.getRange(2, 2, dataRows, 1).setDataValidation(validation);
  sheet.autoResizeColumn(1);
  sheet.setColumnWidth(2, 190);
}

function activeReviewVerdict_(verdictValue, expiryValue) {
  const verdict = normalizeReviewVerdict_(verdictValue);
  if (!expiryValue) return verdict;

  const expiry = expiryValue instanceof Date
    ? expiryValue
    : new Date(expiryValue);
  if (!isNaN(expiry.getTime()) && expiry.getTime() < new Date().getTime()) {
    return 'UNVERIFIED';
  }
  return verdict;
}

function normalizeReviewVerdict_(value) {
  const verdict = String(value || 'UNVERIFIED').trim().toUpperCase();
  return ['CONFIRMED_BENIGN', 'CONFIRMED_MALICIOUS'].indexOf(verdict) >= 0
    ? verdict
    : 'UNVERIFIED';
}

function getFindingReviewStatus_(domains, reviewMap) {
  if (!domains.length) return 'UNVERIFIED';
  const verdicts = domains.map(function(domain) {
    return reviewMap[String(domain).toLowerCase()] || 'UNVERIFIED';
  });

  if (verdicts.indexOf('CONFIRMED_MALICIOUS') >= 0) {
    return 'CONFIRMED_MALICIOUS';
  }
  if (verdicts.every(function(verdict) { return verdict === 'CONFIRMED_BENIGN'; })) {
    return 'CONFIRMED_BENIGN';
  }
  return 'UNVERIFIED';
}

function reviewStatusLabel_(reviewStatus) {
  if (reviewStatus === 'CONFIRMED_MALICIOUS') return 'Confirmed Threat';
  if (reviewStatus === 'CONFIRMED_BENIGN') return 'Verified Benign';
  return 'Pending Review';
}

function severityFromScore_(score) {
  if (score >= 0.75) return 'Critical';
  if (score >= 0.50) return 'High';
  if (score >= 0.25) return 'Medium';
  return 'Low';
}

function calculateMetrics_(report, findings, reportKey, reportFrom, reportTo, previous) {
  const severityCounts = {Critical: 0, High: 0, Medium: 0, Low: 0};
  const riskCounts = {};
  const domainCounts = {};
  let newCount = 0;
  let recurringCount = 0;
  let forwarderCount = 0;
  let confirmedMaliciousCount = 0;
  let confirmedBenignCount = 0;
  let unverifiedCount = 0;

  findings.forEach(function(finding) {
    severityCounts[finding.severity]++;
    if (finding.operationalStatus === 'Recurring') recurringCount++;
    else newCount++;
    if (finding.assetRole === 'DNS Forwarder') forwarderCount++;
    if (finding.reviewStatus === 'CONFIRMED_MALICIOUS') confirmedMaliciousCount++;
    else if (finding.reviewStatus === 'CONFIRMED_BENIGN') confirmedBenignCount++;
    else unverifiedCount++;

    finding.contributors.forEach(function(risk) {
      const key = String(risk).toLowerCase();
      riskCounts[key] = (riskCounts[key] || 0) + 1;
    });

    finding.domains.forEach(function(domain) {
      const key = domain.toLowerCase();
      domainCounts[key] = (domainCounts[key] || 0) + 1;
    });
  });

  const totalSourceIps = Number(report.ipCountTotal || 0);
  const compromisedCount = findings.length;
  const previousCount = previous ? Number(previous.compromisedCount || 0) : null;

  return {
    reportKey: reportKey,
    reportFrom: reportFrom,
    reportTo: reportTo,
    totalSourceIps: totalSourceIps,
    compromisedCount: compromisedCount,
    compromisedRate: totalSourceIps > 0 ? compromisedCount / totalSourceIps : 0,
    severityCounts: severityCounts,
    riskCounts: riskCounts,
    topDomains: objectCountsToTopList_(domainCounts, 6),
    newCount: newCount,
    recurringCount: recurringCount,
    forwarderCount: forwarderCount,
    confirmedMaliciousCount: confirmedMaliciousCount,
    confirmedBenignCount: confirmedBenignCount,
    unverifiedCount: unverifiedCount,
    previousCompromisedCount: previousCount,
    changeVsPrevious: previousCount === null ? null : compromisedCount - previousCount,
    generatedAt: new Date()
  };
}

function ensureWorkspace_() {
  const properties = PropertiesService.getScriptProperties();
  let rootFolder = null;
  const storedFolderId = properties.getProperty('ROOT_FOLDER_ID');

  if (storedFolderId) {
    try {
      rootFolder = DriveApp.getFolderById(storedFolderId);
      rootFolder.getName();
    } catch (error) {
      rootFolder = null;
    }
  }

  if (!rootFolder) {
    rootFolder = getOrCreateChildFolder_(
      DriveApp.getRootFolder(),
      BLUECAT_REPORTING.ROOT_FOLDER_NAME
    );
    properties.setProperty('ROOT_FOLDER_ID', rootFolder.getId());
  }

  let spreadsheet = null;
  const storedSpreadsheetId = properties.getProperty('HISTORY_SPREADSHEET_ID');
  if (storedSpreadsheetId) {
    try {
      spreadsheet = SpreadsheetApp.openById(storedSpreadsheetId);
    } catch (error) {
      spreadsheet = null;
    }
  }

  if (!spreadsheet) {
    spreadsheet = SpreadsheetApp.create(BLUECAT_REPORTING.HISTORY_FILE_NAME);
    DriveApp.getFileById(spreadsheet.getId()).moveTo(rootFolder);
    properties.setProperty('HISTORY_SPREADSHEET_ID', spreadsheet.getId());
  }

  const summarySheet = getOrCreateSheet_(
    spreadsheet,
    'DailySummary',
    DAILY_SUMMARY_HEADERS
  );
  const findingsSheet = getOrCreateSheet_(
    spreadsheet,
    'Findings',
    FINDING_HEADERS
  );
  const domainReviewSheet = getOrCreateSheet_(
    spreadsheet,
    'DomainReview',
    DOMAIN_REVIEW_HEADERS
  );

  return {
    rootFolder: rootFolder,
    spreadsheet: spreadsheet,
    summarySheet: summarySheet,
    findingsSheet: findingsSheet,
    domainReviewSheet: domainReviewSheet
  };
}

function getOrCreateSheet_(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    const sheets = spreadsheet.getSheets();
    if (sheets.length === 1 && sheets[0].getLastRow() === 0) {
      sheet = sheets[0];
      sheet.setName(name);
    } else {
      sheet = spreadsheet.insertSheet(name);
    }
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#16324F')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold');
  sheet.getRange(1, 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  sheet.setFrozenRows(1);

  return sheet;
}

function getPriorIpSet_(findingsSheet, currentReportKey) {
  const set = new Set();
  if (findingsSheet.getLastRow() <= 1) return set;

  const values = findingsSheet.getRange(
    2,
    1,
    findingsSheet.getLastRow() - 1,
    FINDING_HEADERS.length
  ).getValues();

  values.forEach(function(row) {
    if (normalizeReportKey_(row[0]) !== currentReportKey && row[1]) {
      set.add(String(row[1]).trim());
    }
  });
  return set;
}

function getPreviousSummary_(summarySheet, currentReportKey) {
  const summaries = readSummaryRows_(summarySheet)
    .filter(function(item) { return item.reportKey < currentReportKey; })
    .sort(function(a, b) { return a.reportKey < b.reportKey ? 1 : -1; });
  return summaries.length ? summaries[0] : null;
}

function upsertDailySummary_(sheet, metrics) {
  const row = [
    metrics.reportKey,
    metrics.reportFrom.toISOString(),
    metrics.reportTo.toISOString(),
    metrics.totalSourceIps,
    metrics.compromisedCount,
    metrics.compromisedRate,
    metrics.severityCounts.Critical,
    metrics.severityCounts.High,
    metrics.severityCounts.Medium,
    metrics.severityCounts.Low,
    metrics.riskCounts.dga || 0,
    metrics.riskCounts.tunneling || 0,
    metrics.riskCounts.typosquat || 0,
    metrics.riskCounts.rebinding || 0,
    metrics.riskCounts.bluecat_threat_protect || metrics.riskCounts.bluecatthreatprotect || 0,
    metrics.newCount,
    metrics.recurringCount,
    metrics.forwarderCount,
    metrics.confirmedMaliciousCount,
    metrics.confirmedBenignCount,
    metrics.unverifiedCount,
    metrics.generatedAt.toISOString()
  ];

  let existingRows = [];
  if (sheet.getLastRow() > 1) {
    existingRows = sheet.getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      DAILY_SUMMARY_HEADERS.length
    ).getValues().filter(function(existingRow) {
      return normalizeReportKey_(existingRow[0]) !== metrics.reportKey;
    }).map(function(existingRow) {
      existingRow[0] = normalizeReportKey_(existingRow[0]);
      return existingRow;
    });
    sheet.getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      DAILY_SUMMARY_HEADERS.length
    ).clearContent();
  }

  const combinedRows = existingRows.concat([row]);
  sheet.getRange(2, 1, combinedRows.length, 1).setNumberFormat('@');
  sheet.getRange(2, 1, combinedRows.length, row.length).setValues(combinedRows);
  sheet.getRange(2, 6, combinedRows.length, 1).setNumberFormat('0.0%');
}

function replaceDailyFindings_(sheet, reportKey, findings) {
  let existingRows = [];
  if (sheet.getLastRow() > 1) {
    existingRows = sheet.getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      FINDING_HEADERS.length
    ).getValues().filter(function(row) {
      return normalizeReportKey_(row[0]) !== reportKey;
    }).map(function(row) {
      row[0] = normalizeReportKey_(row[0]);
      return row;
    });
    sheet.getRange(
      2,
      1,
      sheet.getLastRow() - 1,
      FINDING_HEADERS.length
    ).clearContent();
  }

  const newRows = findings.map(function(finding) {
    return [
      finding.reportKey,
      finding.ip,
      finding.score,
      finding.severity,
      finding.assetRole,
      finding.site,
      finding.contributors.join(', '),
      finding.indicators.join(', '),
      finding.domains.join(', '),
      finding.operationalStatus,
      finding.reviewStatus
    ];
  });

  const combinedRows = existingRows.concat(newRows);
  if (combinedRows.length) {
    sheet.getRange(2, 1, combinedRows.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, combinedRows.length, FINDING_HEADERS.length)
      .setValues(combinedRows);
  }
}

function readSummaryRows_(sheet) {
  if (sheet.getLastRow() <= 1) return [];
  return sheet.getRange(
    2,
    1,
    sheet.getLastRow() - 1,
    DAILY_SUMMARY_HEADERS.length
  ).getValues().map(function(row) {
    return {
      reportKey: normalizeReportKey_(row[0]),
      totalSourceIps: Number(row[3] || 0),
      compromisedCount: Number(row[4] || 0),
      compromisedRate: Number(row[5] || 0),
      critical: Number(row[6] || 0),
      high: Number(row[7] || 0),
      medium: Number(row[8] || 0),
      low: Number(row[9] || 0)
    };
  });
}

function getRecentSummaries_(sheet, limit) {
  const uniqueByDate = {};
  readSummaryRows_(sheet).forEach(function(summary) {
    if (summary.reportKey) uniqueByDate[summary.reportKey] = summary;
  });
  return Object.keys(uniqueByDate)
    .map(function(reportKey) { return uniqueByDate[reportKey]; })
    .sort(function(a, b) { return a.reportKey > b.reportKey ? 1 : -1; })
    .slice(-limit);
}

function getArchiveFolder_(rootFolder, reportKey) {
  const parts = reportKey.split('-');
  const yearFolder = getOrCreateChildFolder_(rootFolder, parts[0]);
  return getOrCreateChildFolder_(yearFolder, parts[1]);
}

function getOrCreateChildFolder_(parentFolder, name) {
  const folders = parentFolder.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parentFolder.createFolder(name);
}

function saveOrUpdateTextFile_(folder, name, content, mimeType) {
  const files = folder.getFilesByName(name);
  if (files.hasNext()) {
    const file = files.next();
    file.setContent(content);
    return file;
  }
  return folder.createFile(name, content, mimeType);
}

function saveOrReplaceBlob_(folder, blob) {
  const files = folder.getFilesByName(blob.getName());
  while (files.hasNext()) {
    files.next().setTrashed(true);
  }
  return folder.createFile(blob);
}

function findingsToCsv_(findings) {
  const rows = [[
    'Source IP', 'Vendor Severity', 'Vendor Score', 'Asset Role', 'Site',
    'Analyzed Risks', 'Live Indicators', 'BlueCat Flagged Domains',
    'Operational Status', 'Review Status'
  ]];

  findings.forEach(function(finding) {
    rows.push([
      finding.ip,
      finding.severity,
      finding.score.toFixed(6),
      finding.assetRole,
      finding.site,
      finding.contributors.join('; '),
      finding.indicators.join('; '),
      finding.domains.join('; '),
      finding.operationalStatus,
      finding.reviewStatus
    ]);
  });

  return rows.map(function(row) {
    return row.map(csvEscape_).join(',');
  }).join('\r\n');
}

function csvEscape_(value) {
  const text = String(value === null || typeof value === 'undefined' ? '' : value);
  return '"' + text.replace(/"/g, '""') + '"';
}

function createManagementPdf_(config, metrics, findings, recentSummaries, pdfName) {
  const presentation = SlidesApp.create(
    config.customerName + ' - BlueCat Daily Security Findings - ' + metrics.reportKey
  );
  const presentationId = presentation.getId();
  let presentationFile;

  try {
    const firstSlide = presentation.getSlides()[0];
    clearSlide_(firstSlide);
    buildExecutiveSlide_(firstSlide, config, metrics);

    const prioritySlide = presentation.appendSlide(SlidesApp.PredefinedLayout.BLANK);
    buildPrioritySlide_(prioritySlide, config, metrics, findings);

    const trendSlide = presentation.appendSlide(SlidesApp.PredefinedLayout.BLANK);
    buildTrendSlide_(trendSlide, config, metrics, findings, recentSummaries);

    presentation.saveAndClose();
    Utilities.sleep(1200);
    presentationFile = DriveApp.getFileById(presentationId);
    return presentationFile.getAs(MimeType.PDF).setName(pdfName);
  } finally {
    try {
      if (!presentationFile) presentationFile = DriveApp.getFileById(presentationId);
      presentationFile.setTrashed(true);
    } catch (cleanupError) {
      console.log('Geçici Slides dosyası temizlenemedi: ' + cleanupError.message);
    }
  }
}

function buildExecutiveSlide_(slide, config, metrics) {
  setSlideBackground_(slide);
  addTitle_(slide, config.customerName + ' | BlueCat Daily Security Report');
  addText_(
    slide,
    formatPeriod_(metrics.reportFrom, metrics.reportTo),
    28, 39, 660, 18, 9, REPORT_COLORS.muted, false
  );

  addMetricCard_(slide, 28, 68, 155, 72, 'TOTAL SOURCE IP', metrics.totalSourceIps, REPORT_COLORS.accent);
  addMetricCard_(slide, 197, 68, 155, 72, 'BLUECAT FLAGGED IP', metrics.compromisedCount, REPORT_COLORS.high);
  addMetricCard_(slide, 366, 68, 155, 72, 'PENDING REVIEW', metrics.unverifiedCount, REPORT_COLORS.medium);
  addMetricCard_(slide, 535, 68, 157, 72, 'CONFIRMED THREATS',
    metrics.confirmedMaliciousCount,
    metrics.confirmedMaliciousCount > 0 ? REPORT_COLORS.critical : REPORT_COLORS.success);

  addPanel_(slide, 28, 158, 430, 100);
  addText_(slide, 'BlueCat Vendor Severity', 42, 171, 220, 20, 12, REPORT_COLORS.text, true);
  drawSeverityBar_(slide, metrics, 42, 205, 398, 20);
  addText_(
    slide,
    'Critical ' + metrics.severityCounts.Critical +
      '   High ' + metrics.severityCounts.High +
      '   Medium ' + metrics.severityCounts.Medium +
      '   Low ' + metrics.severityCounts.Low,
    42, 233, 398, 16, 9, REPORT_COLORS.muted, false
  );

  addPanel_(slide, 474, 158, 218, 100);
  const status = executiveStatus_(metrics);
  addText_(slide, 'REVIEW STATUS', 488, 172, 190, 18, 9, REPORT_COLORS.muted, true);
  addText_(slide, status.label, 488, 197, 190, 26, 17, status.color, true);
  addText_(slide, changeText_(metrics), 488, 226, 190, 16, 9, REPORT_COLORS.text, false);

  addPanel_(slide, 28, 274, 326, 92);
  addText_(slide, 'Operational View', 42, 287, 200, 18, 11, REPORT_COLORS.text, true);
  addText_(
    slide,
    'New: ' + metrics.newCount + '\nRecurring: ' + metrics.recurringCount +
      '\nDNS forwarder attribution: ' + metrics.forwarderCount,
    42, 311, 290, 48, 10, REPORT_COLORS.muted, false
  );

  addPanel_(slide, 370, 274, 322, 92);
  addText_(slide, 'Top Risk Contributors', 384, 287, 220, 18, 11, REPORT_COLORS.text, true);
  const riskText = topRiskText_(metrics.riskCounts);
  addText_(slide, riskText || 'No contributor data', 384, 311, 290, 46, 10, REPORT_COLORS.muted, false);
  addFooter_(slide, metrics.reportKey, 1);
}

function buildPrioritySlide_(slide, config, metrics, findings) {
  setSlideBackground_(slide);
  addTitle_(slide, 'BlueCat Findings - Verification Required');
  addText_(
    slide,
    'Vendor detection is not a confirmed incident. Analyst review status is shown separately.',
    28, 39, 650, 18, 9, REPORT_COLORS.muted, false
  );

  if (!findings.length) {
    addPanel_(slide, 28, 85, 664, 220);
    addText_(slide, 'BlueCat did not flag a potentially compromised source IP.', 60, 170, 600, 40, 18, REPORT_COLORS.success, true, 'center');
    addFooter_(slide, metrics.reportKey, 2);
    return;
  }

  const displayFindings = findings.slice(0, BLUECAT_REPORTING.MAX_PRIORITY_ROWS);
  const headers = ['Source IP', 'Vendor Risk', 'Review', 'Role', 'Site', 'Reason', 'Flagged domain'];
  const table = slide.insertTable(
    displayFindings.length + 1,
    headers.length,
    28, 72, 664, 252
  );

  headers.forEach(function(header, columnIndex) {
    styleTableCell_(table.getCell(0, columnIndex), header, REPORT_COLORS.panelLight, REPORT_COLORS.text, true, 8);
  });

  displayFindings.forEach(function(finding, rowIndex) {
    const background = rowIndex % 2 === 0 ? REPORT_COLORS.panel : REPORT_COLORS.panelLight;
    const values = [
      finding.ip,
      finding.severity + ' / ' + finding.score.toFixed(3),
      reviewStatusLabel_(finding.reviewStatus),
      finding.assetRole,
      truncate_(finding.site, 22),
      truncate_(finding.contributors.join(', '), 28),
      truncate_(finding.domains.join(', '), 36)
    ];

    values.forEach(function(value, columnIndex) {
      const color = columnIndex === 1
        ? severityColor_(finding.severity)
        : columnIndex === 2
          ? reviewStatusColor_(finding.reviewStatus)
          : REPORT_COLORS.text;
      styleTableCell_(
        table.getCell(rowIndex + 1, columnIndex),
        value,
        background,
        color,
        columnIndex === 1 || columnIndex === 2,
        7
      );
    });
  });

  addPanel_(slide, 28, 338, 664, 36);
  addText_(
    slide,
    'Score 0-1 vendor risk scale; 1 higher risk. It is not a probability or confirmation.  ' +
      'Pending: ' + metrics.unverifiedCount + ' | Benign: ' + metrics.confirmedBenignCount +
      ' | Confirmed threat: ' + metrics.confirmedMaliciousCount,
    42, 348, 635, 18, 9, REPORT_COLORS.muted, false
  );
  addFooter_(slide, metrics.reportKey, 2);
}

function buildTrendSlide_(slide, config, metrics, findings, recentSummaries) {
  setSlideBackground_(slide);
  addTitle_(slide, 'Rolling Trend & False-Positive Review');
  addText_(
    slide,
    'Each bar represents one distinct report day; test reruns are deduplicated.',
    28, 39, 665, 18, 9, REPORT_COLORS.muted, false
  );

  addPanel_(slide, 28, 72, 420, 160);
  addText_(slide, 'Rolling 7-Day BlueCat Finding Trend', 42, 84, 330, 18, 11, REPORT_COLORS.text, true);
  drawTrendBars_(slide, recentSummaries, 45, 112, 386, 100);

  addPanel_(slide, 464, 72, 228, 160);
  addText_(slide, 'Most Frequently Flagged Domains', 478, 84, 200, 18, 10, REPORT_COLORS.text, true);
  const domainLines = metrics.topDomains.length
    ? metrics.topDomains.map(function(item) {
        return truncate_(item.name, 27) + '  (' + item.count + ')';
      }).join('\n')
    : 'No domain data';
  addText_(slide, domainLines, 478, 110, 194, 105, 9, REPORT_COLORS.muted, false);

  addPanel_(slide, 28, 248, 664, 120);
  addText_(slide, 'Attribution / Review Recommendation', 42, 261, 620, 18, 11, REPORT_COLORS.text, true);
  addText_(
    slide,
    optimizationRecommendation_(metrics, findings),
    42, 287, 620, 66, 10, REPORT_COLORS.muted, false
  );
  addFooter_(slide, metrics.reportKey, 3);
}

function clearSlide_(slide) {
  slide.getPageElements().forEach(function(element) {
    element.remove();
  });
}

function setSlideBackground_(slide) {
  slide.getBackground().setSolidFill(REPORT_COLORS.background);
}

function addTitle_(slide, text) {
  addText_(slide, text, 28, 15, 664, 28, 19, REPORT_COLORS.text, true);
}

function addFooter_(slide, reportKey, pageNumber) {
  addText_(
    slide,
    'Source: BlueCat Edge  |  ' + reportKey + '  |  Page ' + pageNumber,
    28, 386, 664, 12, 7, REPORT_COLORS.muted, false, 'right'
  );
}

function addMetricCard_(slide, left, top, width, height, label, value, accentColor) {
  addPanel_(slide, left, top, width, height);
  addText_(slide, label, left + 12, top + 11, width - 24, 14, 8, REPORT_COLORS.muted, true);
  addText_(slide, String(value), left + 12, top + 31, width - 24, 29, 20, accentColor, true);
}

function addPanel_(slide, left, top, width, height) {
  const shape = slide.insertShape(
    SlidesApp.ShapeType.ROUND_RECTANGLE,
    left, top, width, height
  );
  shape.getFill().setSolidFill(REPORT_COLORS.panel);
  shape.getBorder().setTransparent();
  return shape;
}

function addText_(slide, text, left, top, width, height, fontSize, color, bold, alignment) {
  const shape = slide.insertTextBox(String(text), left, top, width, height);
  const textRange = shape.getText();
  textRange.getTextStyle()
    .setFontFamily('Arial')
    .setFontSize(fontSize)
    .setForegroundColor(color)
    .setBold(Boolean(bold));
  textRange.getParagraphStyle().setParagraphAlignment(
    alignment === 'center'
      ? SlidesApp.ParagraphAlignment.CENTER
      : alignment === 'right'
        ? SlidesApp.ParagraphAlignment.END
        : SlidesApp.ParagraphAlignment.START
  );
  shape.setContentAlignment(SlidesApp.ContentAlignment.MIDDLE);
  return shape;
}

function drawSeverityBar_(slide, metrics, left, top, width, height) {
  const total = Math.max(1, metrics.compromisedCount);
  const segments = [
    ['Critical', REPORT_COLORS.critical],
    ['High', REPORT_COLORS.high],
    ['Medium', REPORT_COLORS.medium],
    ['Low', REPORT_COLORS.low]
  ];
  let currentLeft = left;

  segments.forEach(function(segment) {
    const count = metrics.severityCounts[segment[0]];
    if (!count) return;
    const segmentWidth = width * count / total;
    const shape = slide.insertShape(
      SlidesApp.ShapeType.RECTANGLE,
      currentLeft, top, segmentWidth, height
    );
    shape.getFill().setSolidFill(segment[1]);
    shape.getBorder().setTransparent();
    currentLeft += segmentWidth;
  });
}

function drawTrendBars_(slide, summaries, left, top, width, height) {
  if (summaries.length < 2) {
    addText_(
      slide,
      'Rolling trend için en az 2 farklı rapor günü gerekir.',
      left, top + 32, width, 24, 12, REPORT_COLORS.muted, false, 'center'
    );
    return;
  }

  const maxValue = Math.max.apply(null, summaries.map(function(item) {
    return item.compromisedCount;
  }).concat([1]));
  const slotWidth = width / summaries.length;

  summaries.forEach(function(item, index) {
    const barHeight = Math.max(2, (height - 24) * item.compromisedCount / maxValue);
    const barWidth = Math.min(34, slotWidth - 8);
    const x = left + index * slotWidth + (slotWidth - barWidth) / 2;
    const y = top + height - 18 - barHeight;
    const bar = slide.insertShape(SlidesApp.ShapeType.RECTANGLE, x, y, barWidth, barHeight);
    bar.getFill().setSolidFill(REPORT_COLORS.accent);
    bar.getBorder().setTransparent();
    addText_(slide, item.compromisedCount, x - 5, y - 14, barWidth + 10, 12, 7, REPORT_COLORS.text, true, 'center');
    addText_(slide, item.reportKey.substring(5), x - 9, top + height - 16, barWidth + 18, 12, 7, REPORT_COLORS.muted, false, 'center');
  });
}

function styleTableCell_(cell, value, background, color, bold, fontSize) {
  cell.getFill().setSolidFill(background);
  const text = cell.getText();
  text.setText(String(value));
  text.getTextStyle()
    .setFontFamily('Arial')
    .setFontSize(fontSize)
    .setForegroundColor(color)
    .setBold(Boolean(bold));
}

function executiveStatus_(metrics) {
  if (metrics.confirmedMaliciousCount > 0) {
    return {label: 'CONFIRMED THREAT', color: REPORT_COLORS.critical};
  }
  if (metrics.unverifiedCount > 0) {
    return {label: 'REVIEW REQUIRED', color: REPORT_COLORS.medium};
  }
  return {label: 'NO ACTIONABLE THREAT', color: REPORT_COLORS.success};
}

function changeText_(metrics) {
  if (metrics.changeVsPrevious === null) return 'Baseline is being created.';
  if (metrics.changeVsPrevious === 0) return 'No change versus previous day.';
  return (metrics.changeVsPrevious > 0 ? '+' : '') + metrics.changeVsPrevious +
    ' BlueCat-flagged IP versus previous day.';
}

function reviewStatusColor_(reviewStatus) {
  if (reviewStatus === 'CONFIRMED_MALICIOUS') return REPORT_COLORS.critical;
  if (reviewStatus === 'CONFIRMED_BENIGN') return REPORT_COLORS.success;
  return REPORT_COLORS.medium;
}

function topRiskText_(riskCounts) {
  return objectCountsToTopList_(riskCounts, 4).map(function(item) {
    return titleCase_(item.name.replace(/_/g, ' ')) + ': ' + item.count;
  }).join('\n');
}

function optimizationRecommendation_(metrics, findings) {
  const forwarderIps = findings
    .filter(function(item) { return item.assetRole === 'DNS Forwarder'; })
    .map(function(item) { return item.ip; });

  if (forwarderIps.length) {
    return forwarderIps.length + ' bulgu aynı zamanda Edge üzerinde DNS forwarder olarak tanımlı: ' +
      forwarderIps.join(', ') + '. Bu adresleri doğrudan compromise olmuş endpoint kabul etmeden önce ' +
      'orijinal istemci görünürlüğü ve ilgili domainlerin sahipliği doğrulanmalıdır. DomainReview kararı ve DNS Activity kanıtı olmadan Trust Policy uygulanmamalıdır.';
  }

  if (metrics.recurringCount > 0) {
    return metrics.recurringCount + ' bulgu önceki günlerde de görüldü. Tekrarlayan domain ve IP kayıtları ' +
      'varlık sahibiyle doğrulanmalı; yalnızca doğrulanmış meşru trafik için dar kapsamlı Trust/Exception pilotu planlanmalıdır.';
  }

  return 'İlk gözlem dönemi devam ediyor. Ham vendor skoru korunarak IP/domain tekrarları toplanmalı; ' +
    'false-positive kararı DNS Activity ve varlık/domain sahipliği doğrulandıktan sonra DomainReview sekmesine işlenmelidir.';
}

function sendReportEmail_(config, metrics, findings, pdfFile) {
  const to = config.testMode ? config.alertTo : config.reportTo;
  const cc = config.testMode ? '' : config.reportCc;
  const prefix = config.testMode ? '[TEST] ' : '';
  const subject = prefix + '[BlueCat] Daily Security Findings | ' +
    config.customerName + ' | ' + metrics.reportKey;

  const reportableFindings = findings.filter(function(finding) {
    return finding.reviewStatus !== 'CONFIRMED_BENIGN';
  });
  const topFindings = reportableFindings.slice(0, 5).map(function(finding) {
    return '<tr>' +
      '<td style="padding:6px;border-bottom:1px solid #ddd">' + escapeHtml_(finding.ip) + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #ddd">' + escapeHtml_(finding.severity) +
        ' / ' + finding.score.toFixed(3) + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #ddd">' +
        escapeHtml_(reviewStatusLabel_(finding.reviewStatus)) + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #ddd">' + escapeHtml_(finding.site) + '</td>' +
      '</tr>';
  }).join('');

  const htmlBody =
    '<div style="font-family:Arial,sans-serif;color:#172033">' +
    '<h2>BlueCat Daily Security Findings</h2>' +
    '<p><b>Customer:</b> ' + escapeHtml_(config.customerName) + '<br>' +
    '<b>Period:</b> ' + escapeHtml_(formatPeriod_(metrics.reportFrom, metrics.reportTo)) + '</p>' +
    '<p><b>Total source IP:</b> ' + metrics.totalSourceIps + '<br>' +
    '<b>BlueCat-flagged potentially compromised IP:</b> ' + metrics.compromisedCount + ' (' +
      formatPercent_(metrics.compromisedRate) + ')<br>' +
    '<b>Pending analyst review:</b> ' + metrics.unverifiedCount + '<br>' +
    '<b>Confirmed threat / Verified benign:</b> ' + metrics.confirmedMaliciousCount +
      ' / ' + metrics.confirmedBenignCount + '<br>' +
    '<b>Vendor Critical / High:</b> ' + metrics.severityCounts.Critical + ' / ' +
      metrics.severityCounts.High + '</p>' +
    '<p style="background:#eef4fb;padding:10px;border-left:4px solid #2563eb">' +
    '<b>Score açıklaması:</b> BlueCat vendor risk skoru 0 ile 1 arasındadır; 1\'e ' +
    'yaklaştıkça göreli risk yükselir. Örneğin <b>0.778, Critical</b> bandındadır. ' +
    'Bu değer %77,8 saldırı olasılığı veya doğrulanmış compromise anlamına gelmez.</p>' +
    (topFindings
      ? '<table style="border-collapse:collapse;font-size:13px"><tr>' +
        '<th style="text-align:left;padding:6px">Source IP</th>' +
        '<th style="text-align:left;padding:6px">Vendor Risk</th>' +
        '<th style="text-align:left;padding:6px">Review Status</th>' +
        '<th style="text-align:left;padding:6px">Site</th></tr>' + topFindings + '</table>'
      : '<p>Analist incelemesi gerektiren veya doğrulanmış tehdit bulunmuyor.</p>') +
    '<p><b>Not:</b> Bu kayıtlar BlueCat tarafından üretilen potansiyel tehdit ' +
    'bulgularıdır; analist doğrulaması yapılmadan kesin güvenlik olayı olarak değerlendirilmez.</p>' +
    '<p>Yönetici raporu PDF olarak ektedir. Ham JSON ve CSV kayıtları Drive arşivinde tutulmaktadır.</p>' +
    (config.testMode
      ? '<p style="color:#b45309"><b>TEST MODE:</b> Bu e-posta yalnızca ALERT_TO adresine gönderildi.</p>'
      : '') +
    '</div>';

  const mailOptions = {
    to: to,
    subject: subject,
    body: 'BlueCat günlük güvenlik raporu PDF olarak ektedir.',
    htmlBody: htmlBody,
    attachments: [pdfFile.getBlob().setName(pdfFile.getName())],
    name: 'BlueCat Security Reporting'
  };
  if (cc) mailOptions.cc = cc;
  MailApp.sendEmail(mailOptions);
}

function sendErrorAlert_(error) {
  try {
    const alertTo = String(
      PropertiesService.getScriptProperties().getProperty('ALERT_TO') || ''
    ).trim();
    if (!alertTo) {
      console.log('ALERT_TO tanımlı olmadığı için hata e-postası gönderilemedi.');
      return;
    }

    const errorText = truncate_(
      String(error && (error.stack || error.message) ? (error.stack || error.message) : error),
      4000
    );
    MailApp.sendEmail({
      to: alertTo,
      subject: '[BlueCat] AUTOMATION ERROR | ' + Utilities.formatDate(
        new Date(),
        BLUECAT_REPORTING.TIME_ZONE,
        'yyyy-MM-dd HH:mm'
      ),
      body: 'BlueCat günlük rapor otomasyonu başarısız oldu.\n\n' + errorText,
      name: 'BlueCat Security Reporting'
    });
  } catch (mailError) {
    console.log('Teknik hata e-postası da gönderilemedi: ' + mailError.message);
  }
}

function normalizeReportKey_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, BLUECAT_REPORTING.TIME_ZONE, 'yyyy-MM-dd');
  }

  const text = String(value || '').trim();
  const isoDate = text.match(/\d{4}-\d{2}-\d{2}/);
  return isoDate ? isoDate[0] : text;
}

function formatPeriod_(from, to) {
  return Utilities.formatDate(from, BLUECAT_REPORTING.TIME_ZONE, 'dd.MM.yyyy HH:mm') +
    ' - ' +
    Utilities.formatDate(to, BLUECAT_REPORTING.TIME_ZONE, 'dd.MM.yyyy HH:mm');
}

function formatPercent_(value) {
  return (Number(value || 0) * 100).toFixed(1) + '%';
}

function severityColor_(severity) {
  return REPORT_COLORS[String(severity).toLowerCase()] || REPORT_COLORS.text;
}

function normalizeStringArray_(value) {
  return Array.isArray(value)
    ? value.filter(function(item) {
        return item !== null && typeof item !== 'undefined' && String(item).trim() !== '';
      }).map(function(item) { return String(item).trim(); })
    : [];
}

function cleanDomain_(domain) {
  return String(domain || '').trim().replace(/\.$/, '');
}

function objectCountsToTopList_(counts, limit) {
  return Object.keys(counts).map(function(key) {
    return {name: key, count: counts[key]};
  }).sort(function(a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return a.name < b.name ? -1 : 1;
  }).slice(0, limit);
}

function titleCase_(text) {
  return String(text).replace(/\b\w/g, function(character) {
    return character.toUpperCase();
  });
}

function truncate_(value, maxLength) {
  const text = String(value === null || typeof value === 'undefined' ? '' : value);
  return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
}

function escapeHtml_(value) {
  return String(value === null || typeof value === 'undefined' ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
