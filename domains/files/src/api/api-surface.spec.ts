import * as root from '../index.js';
import * as api from './index.js';

describe('@domain/files entry points', () => {
  it('./api exports the module, its config namespace and its permission vocabulary', () => {
    expect(Object.keys(api).sort()).toEqual([
      'FILES_RBAC',
      'FilesModule',
      'FilesPermission',
      'filesConfig',
      'filesEnvSchema',
    ]);
  });

  it('the root entry still exports everything else', () => {
    expect(root).toHaveProperty('FilesModule', api.FilesModule);
    expect(root).toHaveProperty('FilesService');
    expect(root).toHaveProperty('buildUserFileKey');
  });
});
