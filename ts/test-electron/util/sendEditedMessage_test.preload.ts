// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import * as sinon from 'sinon';

import type { ConversationModel } from '../../models/conversations.preload.ts';
import type { MessageAttributesType } from '../../model-types.d.ts';
import { MessageModel } from '../../models/messages.preload.ts';
import { DataReader, DataWriter } from '../../sql/Client.preload.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import {
  generateAci,
  generatePni,
} from '../../test-helpers/serviceIdUtils.std.ts';
import { generateMessageId } from '../../util/generateMessageId.node.ts';
import { sendEditedMessage } from '../../util/sendEditedMessage.preload.ts';
import { conversationJobQueue } from '../../jobs/conversationJobQueue.preload.ts';
import { SendStatus } from '../../messages/MessageSendState.std.ts';
import { BodyRange } from '../../types/BodyRange.std.ts';
import { DurationInSeconds } from '../../util/durations/index.std.ts';
import { handleEditMessage } from '../../util/handleEditMessage.preload.ts';

describe('sendEditedMessage automatic link preview', () => {
  const body = 'Read https://signal.org/blog/';
  const preview = [{ url: 'https://signal.org/blog/', title: 'Signal blog' }];
  let conversation: ConversationModel;
  let target: MessageModel;
  let sandbox: sinon.SinonSandbox;
  let addJob: sinon.SinonStub;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    await DataWriter.removeAll();
    const ourAci = generateAci();
    await itemStorage.user.setCredentials({
      number: '+15550000000',
      aci: ourAci,
      pni: generatePni(),
      deviceId: 2,
      deviceName: 'test',
      password: 'password',
    });
    await itemStorage.put('linkPreviews', true);
    window.ConversationController.reset();
    await window.ConversationController.load();
    await window.ConversationController.getOrCreateAndWait(ourAci, 'private');
    conversation = await window.ConversationController.getOrCreateAndWait(
      generateAci(),
      'private'
    );
    const timestamp = Date.now();
    target = window.MessageCache.register(
      new MessageModel({
        ...generateMessageId(timestamp),
        conversationId: conversation.id,
        type: 'outgoing',
        body,
        bodyRanges: [{ start: 0, length: 4, style: BodyRange.Style.BOLD }],
        preview: [],
        attachments: [],
        timestamp,
        sent_at: timestamp,
        expireTimer: DurationInSeconds.fromSeconds(60),
        expirationStartTimestamp: timestamp,
        quote: {
          id: timestamp - 100,
          authorAci: ourAci,
          text: 'A quoted message',
          attachments: [],
          isViewOnce: false,
          referencedMessageNotFound: false,
        },
        sendStateByConversationId: {
          [conversation.id]: { status: SendStatus.Sent, updatedAt: timestamp },
        },
      })
    );
    await window.MessageCache.saveMessage(target, { forceSave: true });
    addJob = sandbox.stub(conversationJobQueue, 'add').resolves();
  });

  afterEach(async () => {
    sandbox.restore();
    await DataWriter.removeAll();
    await itemStorage.fetch();
  });

  function completePreview() {
    return sendEditedMessage(conversation.id, {
      targetMessageId: target.id,
      body,
      preview,
      linkPreviewOnly: true,
    });
  }

  function applyPreview() {
    return handleEditMessage(target.attributes, {
      conversationId: conversation.id,
      fromId: window.ConversationController.getOurConversationIdOrThrow(),
      fromDevice: 2,
      message: {
        ...target.attributes,
        preview,
        timestamp: target.get('timestamp') + 1,
      },
      isLinkPreviewUpdate: true,
    });
  }

  it('saves and queues a preview edit while preserving the next draft and original content', async () => {
    const original = target.attributes;
    conversation.set({
      draft: 'My next message',
      quotedMessageId: 'next-quote',
      isArchived: true,
    });
    const clearTyping = sandbox.spy(conversation, 'clearTypingTimers');
    const beforeSend = sandbox.spy(conversation, 'beforeMessageSend');

    await completePreview();

    assert.deepEqual(target.get('preview'), preview);
    assert.deepEqual(target.get('bodyRanges'), original.bodyRanges);
    assert.deepEqual(target.get('quote'), original.quote);
    assert.equal(target.get('expireTimer'), original.expireTimer);
    assert.equal(
      target.get('expirationStartTimestamp'),
      original.expirationStartTimestamp
    );
    assert.lengthOf(target.get('editHistory') ?? [], 2);
    assert.isEmpty(target.get('editHistory')?.[1]?.preview);
    assert.equal(conversation.get('draft'), 'My next message');
    assert.equal(conversation.get('quotedMessageId'), 'next-quote');
    assert.isTrue(conversation.get('isArchived'));
    sinon.assert.notCalled(clearTyping);
    sinon.assert.notCalled(beforeSend);
    sinon.assert.calledOnce(addJob);
    assert.equal(addJob.firstCall.args[0].messageId, target.id);
    assert.isAbove(
      addJob.firstCall.args[0].editedMessageTimestamp,
      original.timestamp
    );
    const saved = await DataReader.getMessageById(target.id);
    assert.deepEqual(saved?.preview, preview);
  });

  Object.entries({
    deleted: { deletedForEveryone: true },
    'edited body': { body: 'A different message' },
    'edited message': { editHistory: [{ timestamp: 1, received_at: 1, body }] },
    'existing preview': { preview },
    'view-once message': { isViewOnce: true },
    'expired message': { expirationStartTimestamp: Date.now() - 120_000 },
  } satisfies Record<string, Partial<MessageAttributesType>>).forEach(
    ([name, changes]) => {
      it(`does not update a ${name}`, async () => {
        target.set(changes);
        const before = target.attributes;
        await completePreview();
        sinon.assert.notCalled(addJob);
        assert.deepEqual(target.attributes, before);
      });
    }
  );

  it('does not update after previews have been disabled', async () => {
    await itemStorage.put('linkPreviews', false);
    await completePreview();
    sinon.assert.notCalled(addJob);
    assert.isEmpty(target.get('preview'));
  });

  it('does not overwrite an edit made while preview attachments are being saved', async () => {
    const applying = applyPreview();
    target.set({ body: 'User edited this message' });

    assert.isFalse(await applying);
    assert.equal(target.get('body'), 'User edited this message');
    assert.isEmpty(target.get('preview'));
    assert.isUndefined(target.get('editHistory'));
  });

  it('does not recreate a message removed while preview attachments are being saved', async () => {
    const applying = applyPreview();
    window.MessageCache.unregister(target.id);

    assert.isFalse(await applying);
    assert.isUndefined(window.MessageCache.getById(target.id));
    assert.isEmpty((await DataReader.getMessageById(target.id))?.preview);
  });

  it('preserves delivery progress made while preview attachments are being saved', async () => {
    target.set({
      sendStateByConversationId: {
        [conversation.id]: {
          status: SendStatus.Pending,
          updatedAt: Date.now(),
        },
      },
    });
    const applying = applyPreview();
    const delivered = {
      [conversation.id]: {
        status: SendStatus.Delivered,
        updatedAt: Date.now(),
      },
    };
    target.set({ sendStateByConversationId: delivered });

    assert.isTrue(await applying);
    assert.deepEqual(
      target.get('editHistory')?.[1]?.sendStateByConversationId,
      delivered
    );
  });
});
