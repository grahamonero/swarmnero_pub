/**
 * Centralized application state and DOM references
 */

// Application state
export const state = {
  identity: null,
  feed: null,
  media: null,
  myProfile: null,
  peerProfiles: {},
  swarmIdToPubkey: {},
  pendingMedia: [],
  pendingFiles: [],
  refreshDebounce: null,
  selectedProfile: null, // pubkey of profile shown in right panel
  selectedThread: null,  // { pubkey, timestamp } of thread shown in right panel
  currentTimeline: [],   // cached timeline for interactions

  // Account management
  accountManager: null,
  accounts: [],
  activeAccountName: null,

  // Wallet
  walletUnlocked: false,    // Quick access to wallet unlock state
  xmrPrice: null,           // Cached XMR price

  // Tips aggregation
  tipsByPost: new Map(),    // Map of "pubkey:timestamp" -> { count, totalAmount }

  // Subaddress to post mapping (for linking wallet transactions to tipped posts)
  subaddressToPost: new Map(),  // Map of subaddress_index -> { pubkey, timestamp }

  // Panel navigation stack
  panelStack: [],           // Navigation history: [{type, data}, ...]
  currentPanel: 'swarm-id', // Current panel type: 'swarm-id', 'wallet', 'profile', 'thread', 'follow', 'about', 'accounts', 'profile-settings', 'messages'

  // Direct Messages
  dm: null,                 // DM manager instance
  dmUnreadCounts: {},       // { pubkeyHex: count }
  activeDMPubkey: null,     // Currently open DM conversation

  // Supporter Manager
  supporterManager: null,   // SupporterManager instance

  // Sync Client
  syncClient: null,         // SyncClient instance for feed backup

  // FoF / Discovery
  fofCache: null,    // FoF cache instance
  tagIndex: null,    // Tag index instance
  fof: null,         // FoF protocol instance

  // Online presence — swarmIds of peers currently active on the Discovery topic
  onlineSwarmIds: new Set(),

  // Reply Notification
  replyNotify: null, // ReplyNotify protocol instance

  // Tip Batcher (delayed tip broadcasts for privacy)
  tipBatcher: null, // TipBatcher instance

  // Tip Notifications (incoming tips)
  tipNotifications: [], // Array of { id, amount, postTimestamp, txid, receivedAt, dismissed }

  // Pending follows - swarmIds currently being followed (to prevent button flicker during re-renders)
  pendingFollows: new Set(),

  // Timeline pagination
  timelinePageSize: 25,    // Number of posts per page
  timelineVisibleCount: 25 // Currently visible posts count (increases with "Load more")
}

// DOM element references (initialized after DOM ready)
export const dom = {
  // Status
  statusEl: null,
  swarmIdEl: null,
  feedLengthEl: null,
  peerCountEl: null,
  headerPeerCountEl: null,

  // Posts
  postsEl: null,

  // Profile
  profileNameEl: null,
  profileBioEl: null,
  profileWebsite: null,
  profileMoneroAddress: null,
  saveProfileBtn: null,
  avatarPreview: null,
  avatarInitial: null,
  uploadAvatarBtn: null,
  removeAvatarBtn: null,
  avatarInput: null,

  // Follow
  followKeyEl: null,
  followBtn: null,
  followingListEl: null,

  // Swarm ID
  copySwarmIdBtn: null,
  quickFollowInput: null,
  quickFollowBtn: null,

  // Left column navigation
  createPostBtn: null,
  logoutBtn: null,

  // Expanded composer
  expandedComposer: null,
  closeExpandedComposer: null,
  cancelExpandedPost: null,
  expPostContent: null,
  expCharCount: null,
  expMediaPreview: null,
  expMediaInput: null,
  expFileInput: null,
  expPostBtn: null,
  expBoldBtn: null,
  expItalicBtn: null,
  expCodeBtn: null,
  expLinkBtn: null,
  expMediaBtn: null,
  expFileBtn: null,
  expEmojiBtn: null,
  expEmojiPicker: null,
  expEmojiGrid: null,

  // Three-column layout
  appLayout: null,
  rightPanel: null,
  panelTitle: null,
  panelContent: null,
  closePanel: null,

  // Right panel sections
  panelEmpty: null,
  profileSection: null,
  followSection: null,
  discoverySection: null,
  aboutSection: null,
  userProfileSection: null,
  accountsSection: null,
  accountsPanelContent: null,

  // Account dropdown and modals
  accountDropdown: null,
  loginModal: null,
  passwordInput: null,
  exportWarningModal: null,
  exportPasswordInput: null,

  // Wallet nav and section
  walletNavBtn: null,
  walletSection: null,
  walletContent: null,

  // Wallet modals
  createWalletModal: null,
  createWalletPassword: null,
  createWalletConfirm: null,
  createWalletCancel: null,
  createWalletSubmit: null,

  restoreWalletModal: null,
  restoreSeed: null,
  restoreHeight: null,
  restorePassword: null,
  restoreWalletCancel: null,
  restoreWalletSubmit: null,

  unlockWalletModal: null,
  unlockWalletPassword: null,
  unlockWalletCancel: null,
  unlockWalletSubmit: null,

  sendPreviewModal: null,
  sendPreviewAddress: null,
  sendPreviewAmount: null,
  sendPreviewFee: null,
  sendPreviewTotal: null,
  sendPreviewCancel: null,
  sendPreviewConfirm: null,

  // Tip modal
  tipModal: null,
  tipAuthor: null,
  tipContent: null,
  tipAmountStep: null,
  tipConfirmStep: null,
  tipSuccessStep: null,
  tipAmount: null,
  tipAddress: null,
  tipCancel: null,
  tipPreview: null,
  tipConfirmAmount: null,
  tipConfirmFee: null,
  tipConfirmTotal: null,
  tipBack: null,
  tipConfirm: null,
  tipTxHash: null,
  tipDone: null,

  // Seed modal
  seedModal: null,
  seedDisplay: null,
  seedClose: null,

  // Messages / DM
  messagesNavBtn: null,
  messagesBadge: null,
  messagesSection: null,
  messagesList: null,
  newMessageBtn: null,
  newMessageModal: null,
  newMessageUserList: null,
  newMessageCancel: null,

  // DM Chat View (center column)
  dmChatView: null,
  dmChatBack: null,
  dmChatAvatar: null,
  dmChatName: null,
  dmChatMessages: null,
  dmMessageInput: null,
  dmSendBtn: null,
  dmBlockBtn: null,
  dmMuteBtn: null,

  // Search
  searchSection: null,
  searchContent: null,

  // Trending
  trendingSection: null,
  trendingContent: null,

  // Settings
  settingsSection: null,
  settingsContent: null
}

/**
 * Initialize DOM references
 */
export function initDom() {
  // Status
  dom.statusEl = document.getElementById('status')
  dom.swarmIdEl = document.getElementById('swarmId')
  dom.feedLengthEl = document.getElementById('feedLength')
  dom.peerCountEl = document.getElementById('peerCount')
  dom.headerPeerCountEl = document.getElementById('headerPeerCount')

  // Posts
  dom.postsEl = document.getElementById('posts')

  // Profile
  dom.profileNameEl = document.getElementById('profileName')
  dom.profileBioEl = document.getElementById('profileBio')
  dom.profileWebsite = document.getElementById('profileWebsite')
  dom.profileMoneroAddress = document.getElementById('profileMoneroAddress')
  dom.saveProfileBtn = document.getElementById('saveProfileBtn')
  dom.avatarPreview = document.getElementById('avatarPreview')
  dom.avatarInitial = document.getElementById('avatarInitial')
  dom.uploadAvatarBtn = document.getElementById('uploadAvatarBtn')
  dom.removeAvatarBtn = document.getElementById('removeAvatarBtn')
  dom.avatarInput = document.getElementById('avatarInput')

  // Follow
  dom.followKeyEl = document.getElementById('followKey')
  dom.followBtn = document.getElementById('followBtn')
  dom.followingListEl = document.getElementById('followingList')

  // Swarm ID
  dom.copySwarmIdBtn = document.getElementById('copySwarmId')
  dom.quickFollowInput = document.getElementById('quickFollowInput')
  dom.quickFollowBtn = document.getElementById('quickFollowBtn')

  // Left column navigation
  dom.createPostBtn = document.getElementById('createPostBtn')
  dom.logoutBtn = document.getElementById('logoutBtn')

  // Expanded composer
  dom.expandedComposer = document.getElementById('expandedComposer')
  dom.closeExpandedComposer = document.getElementById('closeExpandedComposer')
  dom.cancelExpandedPost = document.getElementById('cancelExpandedPost')
  dom.expPostContent = document.getElementById('expPostContent')
  dom.expCharCount = document.getElementById('expCharCount')
  dom.expMediaPreview = document.getElementById('expMediaPreview')
  dom.expMediaInput = document.getElementById('expMediaInput')
  dom.expFileInput = document.getElementById('expFileInput')
  dom.expPostBtn = document.getElementById('expPostBtn')
  dom.expBoldBtn = document.getElementById('expBoldBtn')
  dom.expItalicBtn = document.getElementById('expItalicBtn')
  dom.expCodeBtn = document.getElementById('expCodeBtn')
  dom.expLinkBtn = document.getElementById('expLinkBtn')
  dom.expMediaBtn = document.getElementById('expMediaBtn')
  dom.expFileBtn = document.getElementById('expFileBtn')
  dom.expEmojiBtn = document.getElementById('expEmojiBtn')
  dom.expEmojiPicker = document.getElementById('expEmojiPicker')
  dom.expEmojiGrid = document.getElementById('expEmojiGrid')

  // Three-column layout
  dom.appLayout = document.getElementById('appLayout')
  dom.rightPanel = document.getElementById('rightPanel')
  dom.panelTitle = document.getElementById('panelTitle')
  dom.panelContent = document.getElementById('panelContent')
  dom.closePanel = document.getElementById('closePanel')

  // Right panel sections
  dom.panelEmpty = document.getElementById('panel-empty')
  dom.profileSection = document.getElementById('profile-section')
  dom.followSection = document.getElementById('follow-section')
  dom.discoverySection = document.getElementById('discovery-section')
  dom.aboutSection = document.getElementById('about-section')
  dom.userProfileSection = document.getElementById('user-profile-section')
  dom.accountsSection = document.getElementById('accounts-section')
  dom.accountsPanelContent = document.getElementById('accountsPanelContent')

  // Account dropdown and modals
  dom.accountDropdown = document.getElementById('accountDropdown')
  dom.loginModal = document.getElementById('loginModal')
  dom.passwordInput = document.getElementById('passwordInput')
  dom.exportWarningModal = document.getElementById('exportWarningModal')
  dom.exportPasswordInput = document.getElementById('exportPasswordInput')

  // Wallet nav and section
  dom.walletNavBtn = document.getElementById('walletNavBtn')
  dom.walletSection = document.getElementById('walletSection')
  dom.walletContent = document.getElementById('walletContent')

  // Wallet modals
  dom.createWalletModal = document.getElementById('createWalletModal')
  dom.createWalletPassword = document.getElementById('createWalletPassword')
  dom.createWalletConfirm = document.getElementById('createWalletConfirm')
  dom.createWalletCancel = document.getElementById('createWalletCancel')
  dom.createWalletSubmit = document.getElementById('createWalletSubmit')

  dom.restoreWalletModal = document.getElementById('restoreWalletModal')
  dom.restoreSeed = document.getElementById('restoreSeed')
  dom.restoreHeight = document.getElementById('restoreHeight')
  dom.restorePassword = document.getElementById('restorePassword')
  dom.restoreWalletCancel = document.getElementById('restoreWalletCancel')
  dom.restoreWalletSubmit = document.getElementById('restoreWalletSubmit')

  dom.unlockWalletModal = document.getElementById('unlockWalletModal')
  dom.unlockWalletPassword = document.getElementById('unlockWalletPassword')
  dom.unlockWalletCancel = document.getElementById('unlockWalletCancel')
  dom.unlockWalletSubmit = document.getElementById('unlockWalletSubmit')

  dom.sendPreviewModal = document.getElementById('sendPreviewModal')
  dom.sendPreviewAddress = document.getElementById('sendPreviewAddress')
  dom.sendPreviewAmount = document.getElementById('sendPreviewAmount')
  dom.sendPreviewFee = document.getElementById('sendPreviewFee')
  dom.sendPreviewTotal = document.getElementById('sendPreviewTotal')
  dom.sendPreviewCancel = document.getElementById('sendPreviewCancel')
  dom.sendPreviewConfirm = document.getElementById('sendPreviewConfirm')

  // Tip modal
  dom.tipModal = document.getElementById('tipModal')
  dom.tipAuthor = document.getElementById('tipAuthor')
  dom.tipContent = document.getElementById('tipContent')
  dom.tipAmountStep = document.getElementById('tipAmountStep')
  dom.tipConfirmStep = document.getElementById('tipConfirmStep')
  dom.tipSuccessStep = document.getElementById('tipSuccessStep')
  dom.tipAmount = document.getElementById('tipAmount')
  dom.tipAddress = document.getElementById('tipAddress')
  dom.tipCancel = document.getElementById('tipCancel')
  dom.tipPreview = document.getElementById('tipPreview')
  dom.tipConfirmAmount = document.getElementById('tipConfirmAmount')
  dom.tipConfirmFee = document.getElementById('tipConfirmFee')
  dom.tipConfirmTotal = document.getElementById('tipConfirmTotal')
  dom.tipBack = document.getElementById('tipBack')
  dom.tipConfirm = document.getElementById('tipConfirm')
  dom.tipTxHash = document.getElementById('tipTxHash')
  dom.tipDone = document.getElementById('tipDone')

  // Seed modal
  dom.seedModal = document.getElementById('seedModal')
  dom.seedDisplay = document.getElementById('seedDisplay')
  dom.seedClose = document.getElementById('seedClose')

  // Messages / DM
  dom.messagesNavBtn = document.getElementById('messagesNavBtn')
  dom.messagesBadge = document.getElementById('messagesBadge')
  dom.messagesSection = document.getElementById('messages-section')
  dom.messagesList = document.getElementById('messagesList')
  dom.newMessageBtn = document.getElementById('newMessageBtn')
  dom.newMessageModal = document.getElementById('newMessageModal')
  dom.newMessageUserList = document.getElementById('newMessageUserList')
  dom.newMessageCancel = document.getElementById('newMessageCancel')

  // DM Chat View (center column)
  dom.dmChatView = document.getElementById('dmChatView')
  dom.dmChatBack = document.getElementById('dmChatBack')
  dom.dmChatAvatar = document.getElementById('dmChatAvatar')
  dom.dmChatName = document.getElementById('dmChatName')
  dom.dmChatMessages = document.getElementById('dmChatMessages')
  dom.dmMessageInput = document.getElementById('dmMessageInput')
  dom.dmSendBtn = document.getElementById('dmSendBtn')
  dom.dmBlockBtn = document.getElementById('dmBlockBtn')
  dom.dmMuteBtn = document.getElementById('dmMuteBtn')

  // Search
  dom.searchSection = document.getElementById('search-section')
  dom.searchContent = document.getElementById('searchContent')

  // Trending
  dom.trendingSection = document.getElementById('trending-section')
  dom.trendingContent = document.getElementById('trendingContent')

  // Settings
  dom.settingsSection = document.getElementById('settings-section')
  dom.settingsContent = document.getElementById('settingsContent')
}

/**
 * Initialize core state with identity, feed, and media instances
 */
export function initState(identity, feed, media) {
  state.identity = identity
  state.feed = feed
  state.media = media
}
