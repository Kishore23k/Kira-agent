import { useEffect, useRef, useState } from 'react'
import {
  AreaCode,
  ChannelType,
  ConnectionStatusHandler,
  DirectChannelIdentifier,
  MessageHandler,
  NCEngine,
} from '@nexconn/chat'
import { ChatUIEvents, NCChatUIApplication } from '@nexconn/chatui'
import './App.css'

const APP_KEY = import.meta.env.VITE_NEXCONN_APP_KEY?.trim()
const USER_NAMES = {
  buyer_1: 'Buyer',
  seller_1: 'Seller',
  kira_bot: 'Kira',
}

let sdkInitialized = false

function serviceHooks() {
  return {
    async reqUserProfiles(userIds) {
      return userIds.map((userId) => ({
        userId,
        name: USER_NAMES[userId] || userId,
      }))
    },
    async reqGroupProfiles(groupIds) {
      return groupIds.map((groupId) => ({ groupId, name: groupId, memberCount: 0 }))
    },
    async reqSystemProfiles(systemIds) {
      return systemIds.map((systemId) => ({ systemId, name: systemId }))
    },
    async reqGroupMembers() {
      return []
    },
  }
}

async function openDirectChannel(chatUI, userId) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await chatUI.openChannel(new DirectChannelIdentifier(userId), true)
    if (result.isOk) return
    if (result.code !== 39005) {
      throw new Error(`Could not open ${USER_NAMES[userId]}'s conversation (${result.code}).`)
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500))
  }
  throw new Error(`Could not open ${USER_NAMES[userId]}'s conversation; the channel list is still loading.`)
}

function App() {
  const [session, setSession] = useState(null)
  const [loadingRole, setLoadingRole] = useState('')
  const [error, setError] = useState('')
  const [typing, setTyping] = useState(false)
  const typingTimer = useRef(null)
  const roleRef = useRef('')
  const openedBuyerChannel = useRef(false)

  function stopTyping() {
    if (typingTimer.current) window.clearTimeout(typingTimer.current)
    typingTimer.current = null
    setTyping(false)
  }

  function startTyping() {
    if (typingTimer.current) window.clearTimeout(typingTimer.current)
    setTyping(true)
    typingTimer.current = window.setTimeout(() => {
      typingTimer.current = null
      setTyping(false)
    }, 30_000)
  }

  useEffect(() => () => {
    if (typingTimer.current) window.clearTimeout(typingTimer.current)
  }, [])

  useEffect(() => {
    if (!session || session.role !== 'buyer' || openedBuyerChannel.current) return
    openedBuyerChannel.current = true
    openDirectChannel(session.chatUI, 'kira_bot').then(() => setError('')).catch((openError) => {
      setError(openError.message || 'Could not open Kira’s conversation.')
    })
  }, [session])

  async function enterAs(role) {
    const userId = role === 'buyer' ? 'buyer_1' : 'seller_1'
    if (!APP_KEY) {
      setError('Set VITE_NEXCONN_APP_KEY in web/.env before connecting.')
      return
    }

    setLoadingRole(role)
    setError('')
    roleRef.current = role
    try {
      if (!sdkInitialized) {
        NCEngine.initialize({ appKey: APP_KEY, areaCode: AreaCode.NA })
        sdkInitialized = true
      }

      const chatUI = NCChatUIApplication.initialize({
        hooks: serviceHooks(),
        language: 'en_US',
      })
      if (!chatUI) throw new Error('Nexconn ChatUI initialization failed.')

      chatUI.addEventListener(ChatUIEvents.MESSAGE_WILL_SEND, (event) => {
        if (roleRef.current !== 'buyer') return
        const { channelIdentifier, params } = event.data
        if (
          channelIdentifier.channelType !== ChannelType.DIRECT
          || channelIdentifier.channelId !== 'kira_bot'
        ) return
        const text = params.content?.text?.trim()
        if (!text) return

        startTyping()
        fetch('/api/kira', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ buyerId: 'buyer_1', text }),
        }).then((response) => {
          if (!response.ok) throw new Error(`Kira request failed (${response.status}).`)
          return response.json()
        }).catch((requestError) => {
          stopTyping()
          setError(requestError.message || 'Could not reach Kira.')
        })
      })

      NCEngine.addConnectionStatusHandler(
        'kira-web-connection',
        new ConnectionStatusHandler({
          onConnectionStatusChanged({ status }) {
            if (roleRef.current) setSession((current) => current
              ? { ...current, connectionStatus: status }
              : current)
          },
        }),
      )
      NCEngine.addMessageHandler('kira-web-messages', new MessageHandler({
        onMessageReceived({ messages }) {
          if (roleRef.current === 'buyer' && messages.some((message) => (
            message.senderUserId === 'kira_bot'
            && message.channelIdentifier.channelId === 'kira_bot'
          ))) stopTyping()
        },
      }))

      chatUI.ready()

      const tokenResponse = await fetch(
        `/api/token?userId=${encodeURIComponent(userId)}`,
      )
      if (!tokenResponse.ok) throw new Error(`Token request failed (${tokenResponse.status}).`)
      const tokenData = await tokenResponse.json()
      if (!tokenData.token) throw new Error('The server did not return a Nexconn token.')

      const connection = await NCEngine.connect({ token: tokenData.token })
      if (!connection.isOk) {
        throw new Error(`Nexconn connection failed (${connection.code}).`)
      }
      setSession({ role, userId, chatUI, connectionStatus: 'Connected' })
    } catch (loginError) {
      roleRef.current = ''
      setError(loginError.message || 'Could not connect to Nexconn.')
    } finally {
      setLoadingRole('')
    }
  }

  async function openConversation(userId) {
    if (!session) return
    try {
      await openDirectChannel(session.chatUI, userId)
      setError('')
    } catch (openError) {
      setError(openError.message || `Could not open ${USER_NAMES[userId]}'s conversation.`)
    }
  }

  if (!session) {
    return (
      <main className="welcome-screen">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">k</span>
          <span>kira<span className="brand-dot">.</span></span>
        </div>
        <section className="welcome-copy">
          <p className="eyebrow">CUSTOMER CARE, MADE HUMAN</p>
          <h1>A better conversation<br />starts here.</h1>
          <p className="welcome-description">
            Choose a view to continue. No account or sign-up needed.
          </p>
        </section>
        <div className="role-cards">
          <button
            className="role-card buyer-card"
            disabled={Boolean(loadingRole)}
            onClick={() => enterAs('buyer')}
            type="button"
          >
            <span className="card-icon" aria-hidden="true">↗</span>
            <span className="card-title">Enter as Buyer</span>
            <span className="card-description">Chat with Kira about your order</span>
            <span className="card-user">buyer_1</span>
            {loadingRole === 'buyer' && <span className="card-loading">Connecting…</span>}
          </button>
          <button
            className="role-card seller-card"
            disabled={Boolean(loadingRole)}
            onClick={() => enterAs('seller')}
            type="button"
          >
            <span className="card-icon" aria-hidden="true">⌘</span>
            <span className="card-title">Enter as Seller</span>
            <span className="card-description">View customer conversations</span>
            <span className="card-user">seller_1</span>
            {loadingRole === 'seller' && <span className="card-loading">Connecting…</span>}
          </button>
        </div>
        {error && <p className="page-error" role="alert">{error}</p>}
        <footer className="welcome-footer">
          <span>SECURE CUSTOMER MESSAGING</span>
          <span>POWERED BY NEXCONN</span>
        </footer>
      </main>
    )
  }

  return (
    <main className="chat-page">
      <header className="app-header">
        <a className="brand-lockup compact-brand" href="/" aria-label="Kira home">
          <span className="brand-mark" aria-hidden="true">k</span>
          <span>kira<span className="brand-dot">.</span></span>
        </a>
        <div className="header-session">
          <span className="connection-dot" aria-hidden="true" />
          <span>{session.connectionStatus || 'Connected'}</span>
          <span className="header-divider" />
          <span className="role-label">{session.role === 'buyer' ? 'Buyer' : 'Seller'}</span>
        </div>
        <button className="switch-role" onClick={() => window.location.reload()} type="button">
          Switch view <span aria-hidden="true">↗</span>
        </button>
      </header>

      <section className="chat-heading">
        <div>
          <p className="eyebrow">{session.role === 'buyer' ? 'YOUR SUPPORT CHAT' : 'SUPPORT INBOX'}</p>
          <h1>{session.role === 'buyer' ? 'Hello, there.' : 'Conversations'}</h1>
          <p className="chat-subtitle">
            {session.role === 'buyer'
              ? 'Kira is here to help with your order.'
              : 'Pick a conversation to see the latest messages.'}
          </p>
        </div>
        {session.role === 'buyer' && (
          <div className={`typing-indicator${typing ? ' is-visible' : ''}`} aria-live="polite">
            <span className="typing-avatar">K</span>
            <span>{typing ? 'Kira is typing...' : 'Kira is ready when you are'}</span>
            {typing && <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>}
          </div>
        )}
      </section>

      {session.role === 'seller' && (
        <nav className="conversation-shortcuts" aria-label="Conversation list">
          <span className="shortcut-label">QUICK CONVERSATIONS</span>
          {['kira_bot', 'buyer_1'].map((userId) => (
            <button key={userId} onClick={() => openConversation(userId)} type="button">
              <span className={`conversation-avatar ${userId === 'kira_bot' ? 'kira-avatar' : ''}`}>
                {userId === 'kira_bot' ? 'K' : 'B'}
              </span>
              <span className="conversation-name">{USER_NAMES[userId]}</span>
              <span className="conversation-id">{userId}</span>
              <span className="conversation-arrow" aria-hidden="true">↗</span>
            </button>
          ))}
        </nav>
      )}

      {error && <p className="inline-error" role="alert">{error}</p>}
      <section className="chat-frame" aria-label="Nexconn chat">
        <nc-chat-ui-app-provider className="nexconn-chat-root" />
      </section>
      <footer className="chat-footer">
        <span>Signed in as <strong>{session.userId}</strong></span>
        <span>Messages are protected by Nexconn</span>
      </footer>
    </main>
  )
}

export default App
