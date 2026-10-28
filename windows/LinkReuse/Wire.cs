using System.Buffers.Binary;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LinkReuse;

internal sealed record Message(string Type, string? Id = null, string? Url = null, string? Error = null, string? Result = null);
internal sealed record Session(string Pipe, string Browser, int ProcessId, long Started, long Created, int BrowserProcessId);
internal sealed record Settings(string Browser);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(Message))]
[JsonSerializable(typeof(Session))]
[JsonSerializable(typeof(Settings))]
internal partial class WireJson : JsonSerializerContext;

internal static class Wire
{
    internal static async Task<Message?> Read(Stream stream, CancellationToken cancellation = default)
    {
        var header = new byte[4];
        var first = await stream.ReadAsync(header.AsMemory(0, 1), cancellation);
        if (first == 0) return null;
        await stream.ReadExactlyAsync(header.AsMemory(1), cancellation);
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is < 1 or > 131072) throw new InvalidDataException("Invalid message size.");
        var data = new byte[length];
        await stream.ReadExactlyAsync(data, cancellation);
        return JsonSerializer.Deserialize(data, WireJson.Default.Message) ?? throw new InvalidDataException("Missing message.");
    }

    internal static async Task Write(Stream stream, Message message, CancellationToken cancellation = default)
    {
        var data = JsonSerializer.SerializeToUtf8Bytes(message, WireJson.Default.Message);
        if (data.Length > 131072) throw new InvalidDataException("Message too large.");
        var packet = new byte[data.Length + 4];
        BinaryPrimitives.WriteInt32LittleEndian(packet, data.Length);
        data.CopyTo(packet.AsSpan(4));
        await stream.WriteAsync(packet, cancellation);
        await stream.FlushAsync(cancellation);
    }
}
