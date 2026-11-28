import { expect, it, onTestFinished, vi } from 'vitest';
import { DeferredPromise } from '#vs/base/common/async.js';
import { DisposableStore } from '#vs/base/common/lifecycle.js';
import { URI } from '#vs/base/common/uri.js';
import { TextFileEditorModel } from '#vs/workbench/services/textfile/common/textFileEditorModel.js';
import {
  workbenchInstantiationService,
  TestServiceAccessor,
} from '#vs/workbench/test/browser/workbenchTestServices.js';

it('checks the reviewed version after an earlier native save drains and before taking the queued snapshot', async () => {
  const disposables = new DisposableStore();
  onTestFinished(() => {
    disposables.dispose();
  });
  const services = workbenchInstantiationService(undefined, disposables);
  const accessor = services.createInstance(TestServiceAccessor);
  const model = disposables.add(
    services.createInstance(TextFileEditorModel, URI.file('/project/notes.txt'), 'utf8', undefined),
  );
  await model.resolve();
  const text = model.textEditorModel!;
  const writing = new DeferredPromise<void>();
  const release = new DeferredPromise<void>();
  const write = accessor.textFileService.write.bind(accessor.textFileService);
  const writes = vi.spyOn(accessor.textFileService, 'write').mockImplementationOnce(async (...args) => {
    void writing.complete();
    await release.p;
    return write(...args);
  });
  text.setValue('first save');
  const first = model.save({ skipSaveParticipants: true });
  await writing.p;
  text.setValue('reviewed edit');
  const version = text.getVersionId();
  const queued = model.save({
    skipSaveParticipants: true,
    validateBeforeWrite: async () => () => {
      if (text.getVersionId() !== version) throw new Error('The reviewed version changed.');
    },
  });
  text.setValue('later user draft');
  const rejected = expect(queued).rejects.toThrow('The reviewed version changed.');
  await release.complete();
  await first;
  await rejected;
  expect(writes).toHaveBeenCalledTimes(1);
  expect(model.isDirty()).toBe(true);
  expect(text.getValue()).toBe('later user draft');
});
