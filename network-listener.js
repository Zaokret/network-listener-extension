const debuggerVersion = '1.0';
const env = 'dev';
const config = {
  prod: {
    baseUrl: '',
  },
  stag: {
    baseUrl: '',
  },
  dev: {
    baseUrl: 'http://localhost:3000',
  },
};

const domainsStorageKey = 'watched_domains';
const resources = ['XHR', 'Fetch'];

/**
 * Listen to the url changes and attach/detach debugger
 * @param {number} tabId
 * @param {{ status: 'loading' | 'complete' | undefined, url: string | undefined }} { status, url }
 * @param {{tabUrl: string}} { url: tabUrl }
 */
function onPageChange(tabId, { status, url }, { url: tabUrl }) {
  // url will be present only if it's changed,
  // so it's an accurate representation of the latest change to url
  shouldListen(url, function (isVendorPortalPage) {
    if (isVendorPortalPage) {
      runIfNotAttached(tabId, function () {
        chrome.debugger.attach({ tabId }, debuggerVersion, onAttached(tabId));
      });
    } else if (status === 'complete') {
      shouldListen(tabUrl, function (isVendorPortalTab) {
        if (!isVendorPortalTab) {
          chrome.debugger.detach({ tabId });
        }
      });
    }
  });
}

/**
 * Should I listen to the network trafic on the page with this url?
 *
 * @param {String} url
 * @returns {boolean}
 */
function shouldListen(url, callback) {
  getPortalUrls(function (portalUrls) {
    callback(url && portalUrls.some((s) => url.indexOf(s) > -1));
  });
}

function runIfNotAttached(tabId, callback) {
  chrome.debugger.getTargets(function (targets) {
    const attached = targets.some((t) => t.type === 'page' && t.tabId === tabId && t.attached);
    if (!attached) {
      callback();
    }
  });
}

/**
 * Once debugger is attached enable network tab and listen to events
 * @param {number} tabId
 * @returns
 */
function onAttached(tabId) {
  return function () {
    chrome.debugger.sendCommand({ tabId }, 'Network.enable');
    // event listener will be removed once debugger is detached from this tab
    chrome.debugger.onEvent.addListener(onNetworkEvent(tabId));
  };
}

/**
 * React to important requests and responses
 * @param {number} tabId
 * @returns
 */
function onNetworkEvent(tabId) {
  return function (debuggeeId, message, params) {
    if (tabId !== debuggeeId.tabId) {
      return;
    }
    if (!importantResourceType(params.type)) {
      return;
    }
    if (message === 'Network.requestWillBeSent') {
      onRequestWillBeSent(tabId, params);
    } else if (message === 'Network.responseReceived') {
      onResponseReceived(tabId, params);
    }
  };
}

/**
 * Is this piece of network trafic important enough to be stored?
 * @param {String} type
 * @returns
 */
function importantResourceType(type) {
  return type && resources.indexOf(type) > -1;
}

/**
 * Store requests
 * @param {*} params
 */
function onRequestWillBeSent(tabId, params) {
  // cover the case when request has post data but omitted becasue it's too large
  // needs te be fetched manually using requestId
  if (params.request.hasPostData && !params.request.postData) {
    chrome.debugger.sendCommand(
      { tabId },
      'Network.getRequestPostData',
      { requestId: params.requestId },
      function (data) {
        params.request.postData = data;
        chrome.storage.local.set({ [params.requestId.toString()]: params });
      }
    );
  } else {
    chrome.storage.local.set({ [params.requestId.toString()]: params });
  }
}

/**
 * Report responses
 * @param {number} tabId
 * @param {*} params
 */
function onResponseReceived(tabId, params) {
  chrome.storage.local.get(params.requestId, function (storage) {
    chrome.debugger.sendCommand(
      { tabId },
      'Network.getResponseBody',
      { requestId: params.requestId },
      function (response) {
        const event = createEvent({
          responseBody: response,
          requestParams: storage[params.requestId],
          responseParams: params,
        });
        collectNetworkEvent(event, function (isSuccess) {
          console.log({ event, isSuccess, name: 'sending network event data' });
          chrome.storage.local.remove(params.requestId);
        });
      }
    );
  });
}

function createEvent({ responseBody, requestParams, responseParams }) {
  return {
    requestId: requestParams.requestId,
    timestamp: requestParams.timestamp,
    type: requestParams.type,
    url: requestParams.request.url,
    method: requestParams.request.method,
    status: responseParams.response.status,
    requestBody: tryToStringify(requestParams.request.postData),
    responseBody: responseBody ? tryToStringify(responseBody.body) : '',
    responseBodyBase64Encoded: responseBody ? responseBody.base64Encoded : false,
  };
}

function tryToStringify(val) {
  if (!val) {
    return '';
  }
  if (typeof val === 'string') {
    return val;
  }
  return JSON.stringify(val);
}

/**
 *  Send post request containing network event with request and response
 * @param {{ request, response }} event
 * @param {(is: boolean) => void} callback
 */
function collectNetworkEvent(event, callback) {
  var xhr = new XMLHttpRequest();
  xhr.withCredentials = true;
  xhr.open('POST', `${config[env].baseUrl}/events`, true);
  xhr.setRequestHeader('Content-Type', 'application/json');

  xhr.addEventListener('readystatechange', function () {
    if (xhr.readyState === XMLHttpRequest.DONE) {
      callback(status >= 200 && status < 400);
    }
  });

  xhr.send(JSON.stringify(event));
}

function getPortalUrls(callback) {
  chrome.storage.local.get(domainsStorageKey, function (storage) {
    if (storage[domainsStorageKey]) {
      callback(storage[domainsStorageKey]);
    } else {
      var xhr = new XMLHttpRequest();
      xhr.withCredentials = true;

      xhr.addEventListener('readystatechange', function () {
        if (this.readyState === 4) {
          const urls = JSON.parse(this.responseText);
          chrome.storage.local.set({ [domainsStorageKey]: urls });
          callback(urls);
        }
      });

      xhr.open('GET', `${config[env].baseUrl}/domains`);

      xhr.send();
    }
  });
}

/**
 * Detach debugger once tab is removed
 * @param {number} tabId
 * @param {*} _
 */
function onTabRemoved(tabId, _) {
  chrome.debugger.detach({ tabId: tabId });
}

chrome.tabs.onRemoved.addListener(onTabRemoved);
chrome.tabs.onUpdated.addListener(onPageChange);

// getPortalUrls(function (urls) {
//   console.log(urls);
// });
