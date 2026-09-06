import { describe, expect, it } from '@jest/globals';
import { SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import * as mail from '../../../../src/infrastructure/mail';
import { MAIL_TRANSPORT } from '../../../../src/infrastructure/mail/mail-transport';
import { MailService } from '../../../../src/infrastructure/mail/mail.service';

describe('mail public surface and injection contract', () => {
  it('exports MailService without exposing the transport token', () => {
    expect(mail.MailService).toBe(MailService);
    expect(mail).not.toHaveProperty('MAIL_TRANSPORT');
  });

  it('injects the transport abstraction into MailService', () => {
    expect(
      Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, MailService),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ param: MAIL_TRANSPORT }),
      ]),
    );
  });
});
