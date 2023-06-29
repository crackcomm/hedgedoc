/*
 * SPDX-FileCopyrightText: 2022 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { Message, MessagePayloads, MessageType } from './message.js'
import { TransportAdapter } from './transport-adapter.js'
import { EventEmitter2, Listener } from 'eventemitter2'

export type MessageEvents = MessageType | 'connected' | 'disconnected' | 'ready'

type MessageEventPayloadMap = {
  [E in MessageEvents]: E extends keyof MessagePayloads
    ? (message: Message<E>) => void
    : () => void
}

export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED'
}

/**
 * Coordinates the sending, receiving and handling of messages for realtime communication.
 */
export class MessageTransporter extends EventEmitter2<MessageEventPayloadMap> {
  private transportAdapter: TransportAdapter | undefined
  private destroyOnMessageEventHandler: undefined | (() => void)
  private destroyOnErrorEventHandler: undefined | (() => void)
  private destroyOnCloseEventHandler: undefined | (() => void)
  private destroyOnConnectedEventHandler: undefined | (() => void)
  private thisSideReady = false
  private otherSideReady = false
  private readyInterval: NodeJS.Timer | undefined

  public sendMessage<M extends MessageType>(content: Message<M>): void {
    if (!this.isConnected()) {
      this.onDisconnecting()
      console.debug(
        "Can't send message over closed connection. Triggering onDisconencted event. Message that couldn't be sent was",
        content
      )
      return
    }

    if (this.transportAdapter === undefined) {
      throw new Error('no transport adapter set')
    }

    try {
      this.transportAdapter.send(content)
    } catch (error: unknown) {
      this.disconnect()
      throw error
    }
  }

  public setAdapter(websocket: TransportAdapter) {
    if (websocket.getConnectionState() !== ConnectionState.CONNECTED) {
      throw new Error('Websocket must be connected')
    }
    this.unbindEventsFromPreviousWebsocket()
    this.thisSideReady = false
    this.otherSideReady = false
    this.transportAdapter = websocket
    this.bindWebsocketEvents(websocket)

    if (this.isConnected()) {
      this.onConnected()
    } else {
      this.destroyOnConnectedEventHandler = websocket.bindOnConnectedEvent(
        this.onConnected.bind(this)
      )
    }
  }

  protected receiveMessage<L extends MessageType>(message: Message<L>): void {
    if (!this.thisSideReady) {
      return
    }
    if (message.type === MessageType.READY_REQUEST) {
      this.sendMessage({ type: MessageType.READY_ANSWER })
      return
    }
    if (message.type === MessageType.READY_ANSWER) {
      this.processReadyAnswer()
      return
    }
    if (!this.isReady()) {
      return
    }
    this.emit(message.type, message)
  }

  private processReadyAnswer() {
    this.stopSendingOfReadyRequests()
    if (this.otherSideReady) {
      return
    }
    this.otherSideReady = true
    this.emit('ready')
  }

  private stopSendingOfReadyRequests() {
    if (this.readyInterval !== undefined) {
      clearInterval(this.readyInterval)
    }
  }

  public disconnect(): void {
    this.transportAdapter?.disconnect()
    this.onDisconnecting()
  }

  public getConnectionState(): ConnectionState {
    return (
      this.transportAdapter?.getConnectionState() ??
      ConnectionState.DISCONNECTED
    )
  }

  private unbindEventsFromPreviousWebsocket() {
    if (this.transportAdapter) {
      this.destroyOnMessageEventHandler?.()
      this.destroyOnCloseEventHandler?.()
      this.destroyOnErrorEventHandler?.()

      this.destroyOnMessageEventHandler = undefined
      this.destroyOnCloseEventHandler = undefined
      this.destroyOnErrorEventHandler = undefined
    }
  }

  private bindWebsocketEvents(websocket: TransportAdapter) {
    this.destroyOnErrorEventHandler = websocket.bindOnErrorEvent(
      this.onDisconnecting.bind(this)
    )
    this.destroyOnCloseEventHandler = websocket.bindOnCloseEvent(
      this.onDisconnecting.bind(this)
    )
    this.destroyOnMessageEventHandler = websocket.bindOnMessageEvent(
      this.receiveMessage.bind(this)
    )
  }

  protected onConnected(): void {
    this.destroyOnConnectedEventHandler?.()
    this.destroyOnConnectedEventHandler = undefined
    this.emit('connected')
  }

  protected onDisconnecting(): void {
    if (this.transportAdapter === undefined) {
      return
    }
    this.stopSendingOfReadyRequests()
    this.unbindEventsFromPreviousWebsocket()
    this.thisSideReady = false
    this.otherSideReady = false
    this.transportAdapter = undefined
    this.emit('disconnected')
  }

  /**
   * Indicates if the message transporter is connected and can send/receive messages.
   */
  public isConnected(): boolean {
    return this.getConnectionState() === ConnectionState.CONNECTED
  }

  /**
   * Indicates if the message transporter is ready to receives messages.
   */
  public isReady(): boolean {
    return this.thisSideReady && this.otherSideReady
  }

  /**
   * Executes the given callback whenever the message transporter receives a ready message.
   * If the messenger has already received a ready message then the callback will be executed immediately.
   *
   * @param callback The callback to execute when ready
   * @return The event listener that waits for ready messages
   */
  public doAsSoonAsReady(callback: () => void): Listener {
    if (this.isReady()) {
      callback()
    }
    return this.on('ready', callback, {
      objectify: true
    }) as Listener
  }

  /**
   * Executes the given callback whenever the message transporter has established a connection.
   * If the messenger is already connected then the callback will be executed immediately.
   *
   * @param callback The callback to execute when connected
   * @return The event listener that waits for connection events
   */
  public doAsSoonAsConnected(callback: () => void): Listener {
    if (this.isConnected()) {
      callback()
    }
    return this.on('connected', callback, {
      objectify: true
    }) as Listener
  }

  /**
   * Marks the transporter as ready for communication and starts sending of ready requests to the other side.
   * This method should be called after all preparations are done and messages can be processed.
   */
  public startSendingOfReadyRequests(): void {
    this.thisSideReady = true

    this.readyInterval = setInterval(() => {
      this.sendMessage({
        type: MessageType.READY_REQUEST
      })
    }, 100)
  }
}