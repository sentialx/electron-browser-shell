const { ipcMain, BrowserWindow, BrowserView } = require('electron')
const { EventEmitter } = require('events')

let popup
const tabs = new Set()
const extensionHosts = new Set()

exports.createPopup = (win, extension) => {
  popup = new BrowserView()
  popup.setBounds({ x: 0, y: 0, width: 256, height: 400 })
  // popup.webContents.loadURL(`chrome-extension://${extension.id}/popup.html?tabId=${win.webContents.id}`)
  popup.webContents.loadURL(`chrome-extension://${extension.id}/popup.html`)
  popup.webContents.openDevTools({ mode: 'detach', activate: true })
  popup.setBackgroundColor('#ff0000')
  return popup
}

const getParentWindowOfTab = tab => {
  switch (tab.getType()) {
    case 'window':
      return BrowserWindow.fromWebContents(tab)
    case 'browserView': {
      const browserView = BrowserView.fromWebContents(tab)
      return BrowserWindow.getAllWindows().find(win =>
        win.getBrowserViews().includes(browserView)
      )
    }
  }
}

const sendToHosts = (eventName, ...args) => {
  extensionHosts.forEach(host => {
    host.send(eventName, ...args)
  })
}

class BrowserActionAPI {
  constructor() {
    ipcMain.handle('browserAction.setBadgeBackgroundColor', () => {
      return true
    })
    ipcMain.handle('browserAction.setBadgeText', () => {
      return true
    })
    ipcMain.handle('browserAction.setTitle', () => {
      return true
    })
  }
}

class WebNavigationAPI {
  constructor(tab) {
    this.tab = tab
    this.tab.on('did-start-navigation', this.onCommitted.bind(this))
    this.tab.once('will-navigate', this.onCreatedNavigationTarget.bind(this))
  }

  onCreatedNavigationTarget(evt, url) {
    sendToHosts('webNavigation.onCreatedNavigationTarget', {
      sourceTabId: this.tab.id,
      sourceProcessId: this.tab.getProcessId(),
      sourceFrameId: 0,
      url,
      tabId: this.tab.id,
      timeStamp: Date.now()
    })
  }

  onCommitted(e, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) {
    sendToHosts('webNavigation.onCommitted', {
      frameId: isMainFrame ? 0 : frameRoutingId,
      parentFrameId: -1,
      processId: this.tab.getProcessId(),
      tabId: this.tab.id,
      timeStamp: Date.now(),
      url
    })
  }
}

class TabsAPI extends EventEmitter {
  static TAB_ID_NONE = -1

  constructor() {
    super()
    this.detailsCache = new Map()

    ipcMain.handle('tabs.get', this.get.bind(this))
    ipcMain.handle('tabs.getAllInWindow', this.getAllInWindow.bind(this))
    ipcMain.handle('tabs.create', this.create.bind(this))
    ipcMain.handle('tabs.insertCSS', this.insertCSS.bind(this))
    ipcMain.handle('tabs.query', this.query.bind(this))
    ipcMain.handle('tabs.reload', this.reload.bind(this))
    ipcMain.handle('tabs.update', this.update.bind(this))
  }

  getTabById(tabId) {
    return Array.from(tabs).find(tab => tab.id === tabId)
  }

  createTabDetails(tab) {
    const win = BrowserWindow.fromWebContents(tab)
    const isMainFrame = win ? win.webContents === tab : false
    const [width = 0, height = 0] = win ? win.getSize() : []

    const details = {
      active: false,
      audible: tab.isCurrentlyAudible(),
      autoDiscardable: true,
      discarded: false,
      favIconUrl: tab.favicon || undefined,
      height,
      highlighted: false,
      id: tab.id,
      incognito: false,
      // index: 0,
      mutedInfo: { muted: tab.audioMuted },
      pinned: false,
      selected: true,
      status: tab.isLoading() ? 'loading' : 'complete',
      title: tab.getTitle(),
      url: tab.getURL(),
      width,
      windowId: win ? win.id : -1
    }

    this.emit('create-tab-info', details)

    this.detailsCache.set(tab, details)
    return details
  }

  getTabDetails(tab) {
    if (this.detailsCache.has(tab)) {
      return this.detailsCache.get(tab)
    }
    const details = this.createTabDetails(tab)
    return details
  }

  get(sender, tabId) {
    const tab = this.getTabById(tabId)
    if (!tab) return { id: this.TAB_ID_NONE }
    return this.getTabDetails(tab)
  }

  getAllInWindow(event, windowId) {
    let senderWindow = getParentWindowOfTab(event.sender)

    const tabsInWindow = Array.from(tabs)
      .filter(tab => {
        const tabWindow = getParentWindowOfTab(tab)
        return senderWindow.id === tabWindow.id
      })
      .map(tab => this.getTabDetails(tab))

    return tabsInWindow
  }

  create(sender, details) {
    const win = new BrowserWindow()
    win.loadURL(details.url)
  }

  insertCSS(sender, tabId, details) {
    const tab = this.getTabById(tabId)
    if (!tab) return

    // TODO: move to webFrame in renderer?
    tab.insertCSS(details.code)
  }

  query(sender, details = {}) {
    const isSet = value => typeof value !== 'undefined'

    const filteredTabs = Array.from(tabs)
      .map(this.getTabDetails.bind(this))
      .filter(tab => {
        if (isSet(details.active) && details.active === tab.active) return true
        // if (details.currentWindow && tab.active) return true
        return true
      })
      .map((tab, index) => {
        tab.index = index
        return tab
      })
    return filteredTabs
  }

  reload(sender, tabId, reloadProperties = {}) {
    const tab = this.getTabById(tabId)
    if (!tab) return
    if (reloadProperties.bypassCache) {
      tab.reloadIgnoringCache()
    } else {
      tab.reload()
    }
  }

  update(sender, tabId, updateProperties) {
    const tab = this.getTabById(tabId)
    if (!tab) return

    const props = updateProperties

    // TODO: validate URL, prevent 'javascript:'
    if (props.url) tab.loadURL(props.url)

    if (props.muted) tab.setAudioMuted(props.muted)
  }

  onCreated(tab) {
    const tabDetails = this.getTabDetails(tab)
    sendToHosts('tabs.onCreated', tabDetails)
  }

  onUpdated(tabId) {
    const tab = this.getTabById(tabId)
    if (!tab) return
    
    let prevDetails
    if (this.detailsCache.has(tab)) {
      prevDetails = this.detailsCache.get(tab)
    }
    if (!prevDetails) return

    const details = this.createTabDetails(tab)

    const compareProps = [
      'status',
      'url',
      'pinned',
      'audible',
      'discarded',
      'autoDiscardable',
      'mutedInfo',
      'favIconUrl',
      'title'
    ]

    let didUpdate = false
    const changeInfo = {}

    for (const prop of compareProps) {
      if (details[prop] !== prevDetails[prop]) {
        changeInfo[prop] = details[prop]
        didUpdate = true
      }
    }

    if (!didUpdate) return

    sendToHosts('tabs.onUpdated', tab.id, changeInfo, details)
  }

  onRemoved(tab, tabId) {
    const details = this.detailsCache.has(tab)
      ? this.detailsCache.get(tab)
      : null
    this.detailsCache.delete(tab)

    const windowId = details ? details.windowId : WindowsAPI.WINDOW_ID_NONE
    const win =
      windowId > -1
        ? BrowserWindow.getAllWindows().find(win => win.id === windowId)
        : null

    sendToHosts('tabs.onRemoved', tabId, {
      windowId,
      isWindowClosing: win ? win.isDestroyed() : false
    })
  }

  onActivated(tabId) {
    const tab = this.getTabById(tabId)
    if (!tab) return
    const win = getParentWindowOfTab(tab)

    // invalidate cache since 'active' has changed
    this.detailsCache.forEach((tabInfo, cacheTab) => {
      tabInfo.active = tabId === cacheTab.id
    })

    sendToHosts('tabs.onActivated', {
      tabId,
      windowId: win.id
    })
  }
}

class WindowsAPI {
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2

  constructor() {
    ipcMain.handle('windows.create', this.create.bind(this))
  }

  create(sender, details) {
    const win = new BrowserWindow()
    win.loadURL(details.url)
  }

  // onRemoved(win) {
  //   sendToHosts('windows.onRemoved', {
  //     windowId: win.id
  //   })
  // }
}

const extensions = {
  browserAction: new BrowserActionAPI(),
  tabs: new TabsAPI(),
  windows: new WindowsAPI()
}

function observeTab(tab) {
  const tabId = tab.id
  tabs.add(tab)

  new WebNavigationAPI(tab)

  const updateEvents = [
    'page-title-updated', // title
    'did-start-loading', // status
    'did-stop-loading', // status
    'media-started-playing', // audible
    'media-paused', // audible
    'did-start-navigation', // url
    'did-redirect-navigation', // url
    'did-navigate-in-page' // url
  ]

  updateEvents.forEach(eventName => {
    tab.on(eventName, () => {
      extensions.tabs.onUpdated(tab.id)
    })
  })

  tab.on('page-favicon-updated', (event, favicons) => {
    tab.favicon = favicons[0]
    extensions.tabs.onUpdated(tab.id)
  })

  tab.once('destroyed', () => {
    tabs.delete(tab)
    extensions.tabs.onRemoved(tab, tabId)
  })

  extensions.tabs.onCreated(tab)
  console.log(`Observing tab[${tabId}][${tab.getType()}] ${tab.getURL()}`)
}

function observeExtensionHost(host) {
  extensionHosts.add(host)

  host.once('destroyed', () => {
    extensionHosts.delete(host)
  })

  console.log(
    `Observing extension host[${host.id}][${host.getType()}] ${host.getURL()}`
  )
}

exports.extensions = extensions
exports.observeTab = observeTab
exports.observeExtensionHost = observeExtensionHost
