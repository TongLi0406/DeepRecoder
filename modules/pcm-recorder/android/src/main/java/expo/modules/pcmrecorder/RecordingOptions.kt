package expo.modules.pcmrecorder

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class RecordingOptions : Record {
  @Field
  var sampleRate: Int = 16000

  @Field
  var fileName: String? = null

  @Field
  var enableMetering: Boolean = true

  @Field
  var meteringInterval: Int = 100
}

class RecordingStatus : Record {
  @Field
  var isRecording: Boolean = false

  @Field
  var filePath: String? = null

  @Field
  var durationMs: Long = 0

  @Field
  var fileSizeBytes: Long = 0
}
