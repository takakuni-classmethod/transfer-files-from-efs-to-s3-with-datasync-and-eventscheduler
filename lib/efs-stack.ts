import {
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_logs as logs,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_efs as efs,
  aws_s3 as s3,
  aws_datasync as datasync,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export class EfsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // CloudWatch Logs for VPC Flow Logs
    const vpcFlowLogsLogGroup = new logs.LogGroup(this, "VPC Flow Logs Log Group", {
        logGroupName: `/aws/vendedlogs/vpcFlowLogs-${this.stackName}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY
      }
    );

    // CloudWatch Logs for DataSync
    const datasyncLogGroup = new logs.LogGroup(this, "DataSync Log Group", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // VPC Flow Logs IAM Role
    const vpcFlowLogsIAMRole = new iam.Role(this, "VPC Flow Logs IAM Role", {
      assumedBy: new iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
      managedPolicies: [
        new iam.ManagedPolicy(this, "FlowLogsIamPolicy", {
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:DescribeLogStreams",
              ],
              resources: [vpcFlowLogsLogGroup.logGroupArn],
            }),
          ],
        }),
      ],
    });

    // VPC
    const vpc = new ec2.Vpc(this, "VPC", {
      cidr: "10.0.1.0/24",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 28,
        },
        {
          name: "Isolated",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 28,
        },
      ],
    });

    // Setting VPC Flow Logs
    new ec2.CfnFlowLog(this, "VPC Flow Log", {
      resourceId: vpc.vpcId,
      resourceType: "VPC",
      trafficType: "ALL",
      deliverLogsPermissionArn: vpcFlowLogsIAMRole.roleArn,
      logDestination: vpcFlowLogsLogGroup.logGroupArn,
      logDestinationType: "cloud-watch-logs",
      logFormat:
        "${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status} ${vpc-id} ${subnet-id} ${instance-id} ${tcp-flags} ${type} ${pkt-srcaddr} ${pkt-dstaddr} ${region} ${az-id} ${sublocation-type} ${sublocation-id} ${pkt-src-aws-service} ${pkt-dst-aws-service} ${flow-direction} ${traffic-path}",
      maxAggregationInterval: 60,
    });

    // SSM IAM Role
    const ssmIamRole = new iam.Role(this, "SSM IAM Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonSSMManagedInstanceCore"
        ),
      ],
    });

    // EC2 Instance
    const instance = new ec2.Instance(this, "EC2 Instance", {
      instanceType: new ec2.InstanceType("t3.micro"),
      machineImage: ec2.MachineImage.latestAmazonLinux({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      vpc,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(8, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      propagateTagsToVolumeOnCreation: true,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
      role: ssmIamRole,
    });

    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;

    // EFS file system
    const fileSystem = new efs.FileSystem(this, "EFS File System", {
      vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      outOfInfrequentAccessPolicy:
        efs.OutOfInfrequentAccessPolicy.AFTER_1_ACCESS,
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      }),
      removalPolicy: RemovalPolicy.DESTROY
    });

    fileSystem.connections.allowDefaultPortFrom(instance);

    instance.userData.addCommands(
      "yum check-update -y",
      "yum upgrade -y",
      "yum install -y amazon-efs-utils",
      "yum install -y nfs-utils",
      "file_system_id=" + fileSystem.fileSystemId,
      "efs_mount_point=/mnt/efs",
      'mkdir -p "${efs_mount_point}"',
      'test -f "/sbin/mount.efs" && echo "${file_system_id}:/ ${efs_mount_point} efs defaults,_netdev" >> /etc/fstab || ' +
        'echo "${file_system_id}.efs.' +
        Stack.of(this).region +
        '.amazonaws.com:/ ${efs_mount_point} nfs4 nfsvers=4.1,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noresvport,_netdev 0 0" >> /etc/fstab',
      "mount -a -t efs,nfs4 defaults"
    );

    // S3 Bucket
    const bucket = new s3.Bucket(this, "Bucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const datasyncIAMRole = new iam.Role(this, "Datasync IAM Role", {
      assumedBy: new iam.ServicePrincipal("datasync.amazonaws.com"),
      managedPolicies: [
        new iam.ManagedPolicy(this, "AWS DataSync S3 Bucket Access", {
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "s3:GetBucketLocation",
                "s3:ListBucket",
                "s3:ListBucketMultipartUploads",
              ],
              resources: [bucket.bucketArn],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "s3:AbortMultipartUpload",
                "s3:DeleteObject",
                "s3:GetObject",
                "s3:ListMultipartUploadParts",
                "s3:PutObjectTagging",
                "s3:GetObjectTagging",
                "s3:PutObject",
              ],
              resources: [`${bucket.bucketArn}/*`],
            }),
          ],
        }),
      ],
    });

    if (cfnInstance.securityGroupIds == undefined) {
      return;
    }

    const locationEFS = new datasync.CfnLocationEFS(this, "Location EFS", {
      ec2Config: {
        securityGroupArns: [
          `arn:aws:ec2:${this.region}:${
            this.account
          }:security-group/${Fn.select(0, cfnInstance.securityGroupIds)}`,
        ],
        subnetArn: `arn:aws:ec2:${this.region}:${this.account}:subnet/${vpc.isolatedSubnets[0].subnetId}`,
        // subnetArn: vpc.isolatedSubnets[0].subnetId,
      },
      efsFilesystemArn: fileSystem.fileSystemArn,
      inTransitEncryption: "TLS1_2",
      subdirectory: "/",
    });

    const locationS3 = new datasync.CfnLocationS3(this, "Location S3", {
      s3BucketArn: bucket.bucketArn,
      s3Config: {
        bucketAccessRoleArn: datasyncIAMRole.roleArn,
      },
      s3StorageClass: "STANDARD",
      subdirectory: "/",
    });

    new datasync.CfnTask(this, "DataSync Task", {
      name: "efs-to-s3",
      sourceLocationArn: locationEFS.attrLocationArn,
      destinationLocationArn: locationS3.attrLocationArn,
      cloudWatchLogGroupArn: datasyncLogGroup.logGroupArn,
      options: {
        logLevel: "TRANSFER",
        atime: "BEST_EFFORT",
        mtime: "PRESERVE",
        objectTags: "PRESERVE",
        overwriteMode: "ALWAYS",
        posixPermissions: "PRESERVE",
        preserveDeletedFiles: "PRESERVE",
        preserveDevices: "NONE",
        taskQueueing: "ENABLED",
        transferMode: "CHANGED",
        gid: "INT_VALUE",
        uid: "INT_VALUE",
        verifyMode: "ONLY_FILES_TRANSFERRED",
      },
    });

    new ec2.SecurityGroup(this, "All Deny Security Group", {
      vpc,
      allowAllOutbound: false,
    });
  }
}
