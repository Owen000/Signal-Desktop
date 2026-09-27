// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import * as sinon from 'sinon';
import { CallLinkRootKey } from '@signalapp/ringrtc';

import {
  getLinkPreviewForSend,
  maybeGrabLinkPreview,
  takePendingLinkPreview,
  removeLinkPreview,
  resetLinkPreview,
  suspendLinkPreviews,
} from '../../services/LinkPreview.preload.ts';
import { calling } from '../../services/calling.preload.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import { LinkPreviewSourceType } from '../../types/LinkPreview.std.ts';
import { CALL_LINK_DEFAULT_STATE } from '../../util/callLinks.std.ts';
import { explodePromise } from '../../util/explodePromise.std.ts';
import type { ReduxActions } from '../../state/types.std.ts';
import type { CallLinkStateType } from '../../types/CallLink.std.ts';

describe('LinkPreview pending send', () => {
  const conversationId = 'conversation';
  const url = `https://signal.link/call/#key=${CallLinkRootKey.generate().toUnredactedString()}`;
  const secondUrl = `https://signal.link/call/#key=${CallLinkRootKey.generate().toUnredactedString()}`;
  const result = { ...CALL_LINK_DEFAULT_STATE, name: 'A call' };
  let sandbox: sinon.SinonSandbox;
  let originalActions: ReduxActions;
  let fetchPreview: sinon.SinonStub;
  let addPreview: sinon.SinonSpy;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox
      .stub(itemStorage, 'get')
      .withArgs('linkPreviews', false)
      .returns(true);
    fetchPreview = sandbox.stub(calling, 'readCallLink');
    originalActions = window.reduxActions;
    addPreview = sinon.spy();
    window.reduxActions = {
      ...originalActions,
      linkPreviews: {
        ...originalActions?.linkPreviews,
        addLinkPreview: addPreview,
        removeLinkPreview: sinon.spy(),
      },
    };
    resetLinkPreview(conversationId);
  });

  afterEach(() => {
    maybeGrabLinkPreview.cancel();
    resetLinkPreview(conversationId);
    sandbox.restore();
    window.reduxActions = originalActions;
  });

  function stagePreview(link: string) {
    maybeGrabLinkPreview(link, LinkPreviewSourceType.Composer, {
      conversationId,
    });
    maybeGrabLinkPreview.flush();
  }

  it('finishes a preview after an immediate send and composer reset', async () => {
    const deferred = explodePromise<CallLinkStateType>();
    fetchPreview.returns(deferred.promise);
    maybeGrabLinkPreview(url, LinkPreviewSourceType.Composer, {
      conversationId,
    });

    const pendingPreview = takePendingLinkPreview(url, conversationId);
    assert.exists(pendingPreview);
    sinon.assert.calledOnce(fetchPreview);
    resetLinkPreview(conversationId);
    addPreview.resetHistory();

    deferred.resolve(result);
    const previews = await pendingPreview?.result;
    assert.equal(previews?.[0]?.url, url);
    assert.equal(previews?.[0]?.title, 'A call');
    assert.isEmpty(getLinkPreviewForSend(url));
    sinon.assert.notCalled(addPreview);
  });

  it('does not replace a newer draft when the sent preview finishes', async () => {
    const first = explodePromise<CallLinkStateType>();
    fetchPreview.onFirstCall().returns(first.promise);
    fetchPreview.onSecondCall().resolves({ ...result, name: 'Next draft' });
    const pendingPreview = takePendingLinkPreview(url, conversationId);
    resetLinkPreview(conversationId);
    stagePreview(secondUrl);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(getLinkPreviewForSend(secondUrl)[0]?.title, 'Next draft');

    first.resolve(result);
    await pendingPreview?.result;
    assert.equal(getLinkPreviewForSend(secondUrl)[0]?.title, 'Next draft');
  });

  it('includes a loaded preview in the initial send without a follow-up', async () => {
    fetchPreview.resolves(result);
    stagePreview(url);
    await new Promise(resolve => setTimeout(resolve, 0));
    const pendingPreview = takePendingLinkPreview(url, conversationId);
    assert.equal(getLinkPreviewForSend(url)[0]?.url, url);
    assert.isUndefined(pendingPreview);
    sinon.assert.calledOnce(fetchPreview);
  });

  it('honors previews explicitly dismissed by the sender', () => {
    suspendLinkPreviews();
    removeLinkPreview(conversationId);
    const pendingPreview = takePendingLinkPreview(url, conversationId);
    assert.isUndefined(pendingPreview);
    sinon.assert.notCalled(fetchPreview);
  });

  it('honors the disabled preview setting', () => {
    sandbox.restore();
    sandbox
      .stub(itemStorage, 'get')
      .withArgs('linkPreviews', false)
      .returns(false);
    fetchPreview = sandbox.stub(calling, 'readCallLink');
    const pendingPreview = takePendingLinkPreview(url, conversationId);
    assert.isUndefined(pendingPreview);
    sinon.assert.notCalled(fetchPreview);
  });

  it("does not hand off a different conversation's request", async () => {
    fetchPreview.resolves(result);
    stagePreview(url);
    const pendingPreview = takePendingLinkPreview(url, 'another-conversation');
    assert.isUndefined(pendingPreview);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('skips a failed preview without rejecting the send', async () => {
    fetchPreview.rejects(new Error('Network failure'));
    const pendingPreview = takePendingLinkPreview(url, conversationId);
    resetLinkPreview(conversationId);
    assert.deepEqual(await pendingPreview?.result, []);
  });

  it('keeps previews disabled for the draft after a fetch error', async () => {
    fetchPreview.rejects(new Error('Network failure'));
    stagePreview(url);
    await new Promise(resolve => setTimeout(resolve, 0));
    const pendingPreview = takePendingLinkPreview(secondUrl, conversationId);
    assert.isUndefined(pendingPreview);
    sinon.assert.calledOnce(fetchPreview);
  });

  it('can cancel a detached request if enqueueing the message fails', async () => {
    const deferred = explodePromise<CallLinkStateType>();
    fetchPreview.returns(deferred.promise);
    const pendingPreview = takePendingLinkPreview(url, conversationId);
    pendingPreview?.abort();
    deferred.resolve(result);
    assert.deepEqual(await pendingPreview?.result, []);
  });

  it('keeps the timeout when the request belongs to a sent message', async () => {
    const clock = sandbox.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
    });
    const deferred = explodePromise<CallLinkStateType>();
    fetchPreview.returns(deferred.promise);
    const pendingPreview = takePendingLinkPreview(url, conversationId);
    resetLinkPreview(conversationId);
    clock.tick(60_000);
    deferred.resolve(result);
    assert.deepEqual(await pendingPreview?.result, []);
    assert.isEmpty(getLinkPreviewForSend(url));
  });

  it('does not restore a canceled draft when its request ignores abort', async () => {
    const deferred = explodePromise<CallLinkStateType>();
    fetchPreview.returns(deferred.promise);
    stagePreview(url);
    removeLinkPreview(conversationId);
    addPreview.resetHistory();
    deferred.resolve(result);
    await new Promise(resolve => setTimeout(resolve, 0));
    sinon.assert.notCalled(addPreview);
    assert.isEmpty(getLinkPreviewForSend(url));
  });

  it('does not include a link removed before sending', async () => {
    const deferred = explodePromise<CallLinkStateType>();
    fetchPreview.returns(deferred.promise);
    stagePreview(url);
    const pendingPreview = takePendingLinkPreview(
      'No link here',
      conversationId
    );
    assert.isUndefined(pendingPreview);
    deferred.resolve(result);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.isEmpty(getLinkPreviewForSend(url));
  });
});
