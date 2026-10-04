import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType('PresignedUploadHeader', { description: 'A header the upload request must carry' })
export class PresignedUploadHeaderModel {
  @Field(() => String)
  name: string;

  @Field(() => String)
  value: string;
}

@ObjectType('PresignedUpload', {
  description: 'PUT the file bytes to `url`, with exactly `headers`, before `expiresAt`',
})
export class PresignedUploadModel {
  @Field(() => String, { description: 'Object key: pass it to download-url / delete' })
  key: string;

  @Field(() => String, { description: 'Sanitized filename' })
  filename: string;

  @Field(() => String)
  url: string;

  @Field(() => String, { description: 'Always PUT' })
  method: string;

  @Field(() => [PresignedUploadHeaderModel])
  headers: PresignedUploadHeaderModel[];

  @Field(() => Date)
  expiresAt: Date;
}
