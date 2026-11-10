import * as root from '../index.js';
import * as api from './index.js';

describe('@domain/files entry points', () => {
  it('./api exports the module and its config namespace', () => {
    expect(Object.keys(api).sort()).toEqual(['FilesModule', 'filesConfig', 'filesEnvSchema']);
  });

  it('the root entry still exports everything else', () => {
    expect(root).toHaveProperty('FilesModule', api.FilesModule);
    expect(root).toHaveProperty('FilesService');
    expect(root).toHaveProperty('buildUserFileKey');
  });
});
