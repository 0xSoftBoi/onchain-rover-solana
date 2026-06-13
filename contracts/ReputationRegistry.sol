// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReputationRegistry — ERC-8004-compatible feedback for the rover fleet.
/// @notice Minimal, same giveFeedback signature/event as the canonical ERC-8004
/// ReputationRegistry, deployed on Arc so the flywheel (job → proof → feedback →
/// rank) is self-contained on the settlement chain. The REQUESTER rates the
/// agent (self-feedback disallowed), tagged by skill.
contract ReputationRegistry {
    struct Feedback {
        address client;
        int128 value;        // e.g. 0..100 ("starred")
        uint8 valueDecimals;
        string tag1;         // skill: "guard" | "courier" | "deliver" | "race"
        string tag2;
        string endpoint;
        string feedbackURI;  // e.g. walrus://<blobId>  (proof)
        bytes32 feedbackHash;
        uint64 ts;
    }

    // agentId => list of feedback
    mapping(uint256 => Feedback[]) private _feedback;
    // agentId => owner (set on first registration; blocks self-feedback)
    mapping(uint256 => address) public agentOwner;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    /// @notice Register who owns an agentId (the robot's wallet), so the
    /// registry can reject self-feedback. Idempotent-ish: first writer wins.
    function setAgentOwner(uint256 agentId, address owner) external {
        if (agentOwner[agentId] == address(0)) agentOwner[agentId] = owner;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        require(msg.sender != agentOwner[agentId], "Self-feedback not allowed");
        uint64 idx = uint64(_feedback[agentId].length);
        _feedback[agentId].push(Feedback({
            client: msg.sender, value: value, valueDecimals: valueDecimals,
            tag1: tag1, tag2: tag2, endpoint: endpoint,
            feedbackURI: feedbackURI, feedbackHash: feedbackHash,
            ts: uint64(block.timestamp)
        }));
        emit NewFeedback(agentId, msg.sender, idx, value, valueDecimals,
            tag1, tag1, tag2, endpoint, feedbackURI, feedbackHash);
    }

    function feedbackCount(uint256 agentId) external view returns (uint256) {
        return _feedback[agentId].length;
    }

    /// @notice Average value + count for an agent (the leaderboard score).
    function getSummary(uint256 agentId)
        external view returns (uint256 count, int256 avgValue)
    {
        Feedback[] storage f = _feedback[agentId];
        count = f.length;
        if (count == 0) return (0, 0);
        int256 sum;
        for (uint256 i; i < count; i++) sum += f[i].value;
        avgValue = sum / int256(count);
    }
}
